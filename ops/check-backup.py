"""Independent monitor: validate an operator-downloaded manifest without using D1 or the app."""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

def verify(manifest, sql=None, clock=None):
    value = json.loads(Path(manifest).read_text())
    value = value.get('lastComplete', value)
    if not value or not all(key in value for key in ('completed','sha256','bytes','schemaVersion')):
        raise ValueError('No complete backup manifest')
    age = (time.time() if clock is None else clock) - value['completed']
    if age < -300 or age > 86400:
        raise ValueError('Backup is stale or has an invalid completion timestamp')
    if sql:
        digest = hashlib.sha256()
        size = 0
        with open(sql, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024*1024), b''):
                size += len(chunk)
                digest.update(chunk)
        if size != value['bytes'] or digest.hexdigest() != value['sha256']:
            raise ValueError('Backup checksum or size mismatch')
    return {'healthy': True, 'age_seconds': int(age), 'schema_version': value['schemaVersion'], 'bytes': value['bytes']}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest')
    parser.add_argument('--sql')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.manifest, args.sql)))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'healthy': False, 'error': str(error)}))
        sys.exit(2)
