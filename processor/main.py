"""One bounded batch. Originals pass through a metered loopback Range proxy, never a local file."""
import http.server
import json
import math
import os
import resource
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

CHUNK = 4 * 1024 * 1024
MAX_SCRATCH = 1024 ** 3
FORMATS = 'mov,matroska,webm,avi,mpeg,mpegts,asf,flv,ogg'

class Failure(Exception):
    pass

class API:
    def __init__(self, origin, token):
        if urllib.parse.urlparse(origin).scheme != 'https':
            raise Failure('invalid_machine_origin')
        self.origin, self.token = origin.rstrip('/'), token

    def call(self, action, data=None, job=None, poster=None):
        headers = {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'}
        if job:
            headers.update({'X-Job-Id': job['id'], 'X-Job-Lease': job['lease']})
        payload = json.dumps(data or {}).encode()
        if poster is not None:
            payload = poster
            headers['Content-Type'] = 'image/jpeg'
        request = urllib.request.Request(self.origin + '/machine/' + action, data=payload, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                if response.headers.get_content_type() != 'application/json':
                    raise Failure('machine_authentication_failed')
                return json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                code = json.loads(exc.read(8192)).get('error', 'network')
            except (ValueError, AttributeError):
                code = 'network'
            raise Failure(code) from None
        except (OSError, TimeoutError):
            raise Failure('network') from None

def bounds(value, size):
    if value is None:
        return 0, size - 1
    import re
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
    if not match or not any(match.groups()) or size <= 0:
        raise ValueError('range')
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise ValueError('range')
        return max(0, size - suffix), size - 1
    start, end = int(first), min(size - 1, int(last) if last else size - 1)
    if start > end or start >= size:
        raise ValueError('range')
    return start, end

class SourceProxy(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, api, job, stopped):
        self.api, self.job, self.stopped = api, job, stopped
        self.path = '/' + uuid.uuid4().hex
        self.read_bytes, self.read_requests = 0, 0
        self.failure = None
        self.lock = threading.Lock()
        super().__init__(('127.0.0.1', 0), SourceHandler)

    def check(self):
        if self.stopped.is_set():
            raise Failure(self.failure or 'processor_failed')
        if time.time() >= self.job['deadline']:
            raise Failure('time_budget_exceeded')

    def read(self, start, end):
        self.check()
        access = self.api.call('access', {'start': start, 'end': end}, self.job)
        parsed = urllib.parse.urlparse(access['url'])
        if parsed.scheme != 'https' or not parsed.hostname.endswith('.r2.cloudflarestorage.com'):
            raise Failure('invalid_source_url')
        request = urllib.request.Request(access['url'], headers=access['headers'])
        try:
            with urllib.request.urlopen(request, timeout=min(12, max(1, self.job['deadline']-time.time()))) as response:
                if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{self.job["bytes"]}':
                    raise Failure('network')
                data = response.read(end-start+2)
                if len(data) != end-start+1:
                    raise Failure('network')
        except urllib.error.HTTPError as exc:
            raise Failure('source_changed' if exc.code == 412 else 'network') from None
        except (OSError, TimeoutError):
            raise Failure('network') from None
        with self.lock:
            self.read_bytes += len(data)
            self.read_requests += 1
            if self.read_bytes > self.job['readLimit']:
                raise Failure('read_budget_exceeded')
        return data

class SourceHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass  # No filenames, signed URLs, credentials, or query strings in logs.

    def do_HEAD(self):
        self.serve(False)

    def do_GET(self):
        self.serve(True)

    def serve(self, send_body):
        proxy = self.server
        if self.path != proxy.path:
            self.send_error(404)
            return
        try:
            proxy.check()
            start, end = bounds(self.headers.get('Range'), proxy.job['bytes'])
        except (ValueError, Failure):
            self.send_error(416)
            return
        self.send_response(206 if self.headers.get('Range') else 200)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(end-start+1))
        if self.headers.get('Range'):
            self.send_header('Content-Range', f'bytes {start}-{end}/{proxy.job["bytes"]}')
        self.end_headers()
        if not send_body:
            return
        try:
            while start <= end:
                data = proxy.read(start, min(end, start+CHUNK-1))
                self.wfile.write(data)
                self.wfile.flush()
                start += len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # FFmpeg may close a range early to seek elsewhere.
        except Failure as exc:
            proxy.failure = str(exc)
            proxy.stopped.set()
        finally:
            self.close_connection = True

def limits():
    resource.setrlimit(resource.RLIMIT_AS, (4*1024**3, 4*1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (4*1024**2, 4*1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))

def execute(args, directory, job, stopped):
    output, error = directory / 'stdout', directory / 'stderr'
    # No shell; fixed filenames and selected fields keep output/scratch finite.
    with output.open('wb') as out, error.open('wb') as err:
        process = subprocess.Popen(args, stdout=out, stderr=err, start_new_session=True, preexec_fn=limits)
        try:
            while process.poll() is None:
                if stopped.wait(.15):
                    raise Failure('processor_failed')
                if time.time() >= job['deadline']:
                    raise Failure('time_budget_exceeded')
                if sum(p.stat().st_size for p in directory.iterdir()) > MAX_SCRATCH:
                    raise Failure('scratch_budget_exceeded')
            if process.returncode:
                raise Failure('unsupported_or_corrupt')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    return output.read_bytes()

def technical(probe):
    streams = probe.get('streams', [])
    video = next((s for s in streams if s.get('codec_type') == 'video'), None)
    if not video:
        raise Failure('unsupported_or_corrupt')
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), {})
    def positive(value):
        try:
            value = float(value)
            return value if math.isfinite(value) and value > 0 else None
        except (ValueError, TypeError):
            return None
    width, height = positive(video.get('width')), positive(video.get('height'))
    sar = video.get('sample_aspect_ratio', '1:1').split(':')
    if width and len(sar) == 2 and positive(sar[0]) and positive(sar[1]):
        width = round(width * float(sar[0]) / float(sar[1]))
    rotation = next((s.get('rotation', 0) for s in video.get('side_data_list', []) if 'rotation' in s), 0)
    if abs(float(rotation)) % 180 == 90:
        width, height = height, width
    return {'duration': positive(probe.get('format', {}).get('duration')) or positive(video.get('duration')),
            'width': width, 'height': height, 'container': probe.get('format', {}).get('format_name'),
            'videoCodec': video.get('codec_name'), 'audioCodec': audio.get('codec_name')}

def process_job(api, job):
    stopped = threading.Event()
    proxy = SourceProxy(api, job, stopped)
    server_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    server_thread.start()
    def heartbeats():
        while not stopped.wait(15):
            try:
                api.call('heartbeat', job=job)
            except Failure as exc:
                proxy.failure = str(exc)
                stopped.set()
    heartbeat_thread = threading.Thread(target=heartbeats, daemon=True)
    heartbeat_thread.start()
    start = time.monotonic()
    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    try:
        api.call('heartbeat', job=job)
        with tempfile.TemporaryDirectory(prefix='embyfin-') as scratch:
            directory = Path(scratch)
            url = f'http://127.0.0.1:{proxy.server_port}{proxy.path}'
            restrictions = ['-protocol_whitelist', 'http,tcp', '-format_whitelist', FORMATS, '-threads', '1', '-rw_timeout', '10000000']
            raw = execute(['ffprobe', '-v', 'error', *restrictions, '-show_entries',
                           'format=duration,format_name:stream=codec_type,codec_name,width,height,duration,sample_aspect_ratio:stream_side_data=rotation',
                           '-of', 'json', url], directory, job, stopped)
            metadata = technical(json.loads(raw))
            at = min(30, metadata['duration']*.1) if metadata['duration'] else 0
            poster = directory / 'poster.jpg'
            execute(['ffmpeg', '-hide_banner', '-v', 'error', '-nostdin', *restrictions, '-ss', str(at), '-i', url,
                     '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-threads', '1', '-filter_threads', '1',
                     '-vf', "scale=w='min(640,iw*sar)':h=-2,setsar=1", '-q:v', '3', '-y', str(poster)], directory, job, stopped)
            proxy.check()
            artifact = poster.read_bytes()
            if len(artifact) > 2*1024**2:
                raise Failure('scratch_budget_exceeded')
            try:
                api.call('poster', job=job, poster=artifact)
            except Failure:
                raise Failure('upload_failed') from None
            usage = resource.getrusage(resource.RUSAGE_CHILDREN)
            metadata.update(elapsedMs=round((time.monotonic()-start)*1000),
                            cpuMs=round((usage.ru_utime+usage.ru_stime-usage_before.ru_utime-usage_before.ru_stime)*1000),
                            peakRss=int(usage.ru_maxrss*(1 if sys.platform=='darwin' else 1024)),
                            peakScratch=sum(p.stat().st_size for p in directory.iterdir()),
                            actualReadBytes=proxy.read_bytes, actualReadRequests=proxy.read_requests)
            api.call('complete', metadata, job)
            print(json.dumps({'event': 'job_complete', **{k: metadata[k] for k in ['elapsedMs','cpuMs','peakRss','peakScratch','actualReadBytes','actualReadRequests']}}))
    except (Failure, ValueError, OSError) as exc:
        code = proxy.failure or (str(exc) if isinstance(exc, Failure) else 'processor_failed')
        print(json.dumps({'event': 'job_failed', 'code': code, 'actualReadBytes': proxy.read_bytes}))
        api.call('fail', {'code': code}, job)
    finally:
        stopped.set()
        proxy.shutdown()
        proxy.server_close()
        heartbeat_thread.join(timeout=13)

def main():
    api = API(os.environ['EMBYFIN_URL'], os.environ['RUN_TOKEN'])
    deadline = int(os.environ['RUN_DEADLINE'])
    while time.time() < deadline:
        # Revalidate generation on every claim, including provider restarts of the entrypoint.
        job = api.call('claim').get('job')
        if not job:
            return
        process_job(api, job)

if __name__ == '__main__':
    try:
        main()
    except Failure as exc:
        print(json.dumps({'event': 'batch_stopped', 'code': str(exc)}))
        raise SystemExit(1) from None
