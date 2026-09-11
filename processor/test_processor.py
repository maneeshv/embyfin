import json
import subprocess
import tempfile
import threading
import time
import unittest
import importlib.util
import hashlib
from pathlib import Path
from unittest.mock import patch, MagicMock
import main

class ProcessorCheck(unittest.TestCase):
    def test_machine_requests_identify_processor_and_keep_authentication(self):
        response=MagicMock()
        response.__enter__.return_value=response
        response.headers.get_content_type.return_value='application/json'
        response.read.return_value=b'{"job":null}'
        with patch.object(main.urllib.request,'urlopen',return_value=response) as send:
            self.assertEqual(main.API('https://media.test','secret').call('claim'),{'job':None})
        request=send.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'),'Embyfin-Processor/0.1')
        self.assertEqual(request.get_header('Authorization'),'Bearer secret')
        self.assertEqual(request.full_url,'https://media.test/machine/claim')

    def test_independent_backup_checksum_and_staleness(self):
        spec=importlib.util.spec_from_file_location('backup',Path(__file__).parents[1]/'ops/check-backup.py')
        backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
        with tempfile.TemporaryDirectory() as folder:
            sql=Path(folder)/'backup.sql';sql.write_bytes(b'SELECT 1;')
            manifest=Path(folder)/'backup.json'
            manifest.write_text(json.dumps({'completed':1000,'bytes':9,'sha256':hashlib.sha256(sql.read_bytes()).hexdigest(),'schemaVersion':1}))
            self.assertTrue(backup.verify(manifest,sql,clock=1001)['healthy'])
            with self.assertRaises(ValueError): backup.verify(manifest,sql,clock=90000)
            sql.write_bytes(b'altered')
            with self.assertRaises(ValueError): backup.verify(manifest,sql,clock=1001)

    def test_ranges_metadata_and_real_ffmpeg_roundtrip(self):
        self.assertEqual(main.bounds('bytes=-3', 10), (7, 9))
        self.assertEqual(main.bounds('bytes=2-', 10), (2, 9))
        for value in ('bytes=-0', 'bytes=20-', 'bytes=2-1', 'bytes=1-2,4-5'):
            with self.assertRaises(ValueError): main.bounds(value, 10)
        details = main.technical({'streams': [{'codec_type':'video','width':1920,'height':1080,'side_data_list':[{'rotation':90}]}]})
        self.assertIsNone(details['duration'])
        self.assertEqual((details['width'], details['height']), (1080, 1920))
        with tempfile.TemporaryDirectory() as folder:
            fixture = Path(folder) / 'fixture.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440',
                            '-t','2','-c:v','libx264','-threads','1','-c:a','aac','-movflags','+faststart',str(fixture)],check=True)
            original=fixture.read_bytes()
            calls=[]
            class API:
                def call(self, action, data=None, job=None, poster=None):
                    calls.append((action,data,poster))
                    return {}
            def read(proxy,start,end):
                proxy.check()
                data=original[start:end+1]
                proxy.read_bytes+=len(data)
                proxy.read_requests+=1
                return data
            job={'id':'fixture','lease':'token','bytes':len(original),'deadline':time.time()+30,'readLimit':256*1024**2}
            # macOS reports maxrss in bytes; Linux container reports KiB. No production callback validates this fake API.
            with patch.object(main.SourceProxy,'read',read),patch.object(main,'limits',lambda:None):
                main.process_job(API(),job)
            result=next((data for action,data,_ in calls if action=='complete'),None)
            self.assertIsNotNone(result, calls)
            self.assertEqual(result['videoCodec'],'h264')
            self.assertEqual(result['audioCodec'],'aac')
            self.assertAlmostEqual(result['duration'],2,places=1)
            poster=next(p for action,_,p in calls if action=='poster')
            self.assertTrue(poster.startswith(b'\xff\xd8') and poster.endswith(b'\xff\xd9'))
            self.assertLess(result['actualReadBytes'],256*1024**2)
            stopped=threading.Event();stopped.set()
            proxy=main.SourceProxy(API(),job,stopped)
            try:
                with self.assertRaises(main.Failure): proxy.check()
            finally: proxy.server_close()

if __name__=='__main__': unittest.main()
