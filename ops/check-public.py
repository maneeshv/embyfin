"""Check/export the public working tree without copying Git history or ignored files."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess


def findings(data, identifiers=()):
    text = data.decode('utf-8', errors='replace')
    problems = []
    if re.search(r'AGE-SECRET-KEY-[A-Z0-9]{50,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----', text):
        problems.append('private key')
    if re.search(r'(?im)^\s*(?:export\s+)?(?:AWS_SECRET_ACCESS_KEY|CLOUDFLARE_API_TOKEN|SOURCE_SECRET_ACCESS_KEY|MACHINE_SECRET)\s*=\s*[\"\']?[a-zA-Z0-9_/-]{24,}', text):
        problems.append('credential assignment')
    for match in re.finditer(r'(?i)(?:account_id|CF_ACCOUNT_ID)[\"\']?\s*[:=]\s*[\"\']([a-f0-9]{32})', text):
        if set(match[1]) != {'0'}:
            problems.append('production account in configuration')
    if any(value and value.encode() in data for value in identifiers):
        problems.append('private deployment identifier')
    return problems


def public_files():
    # Git knows the public boundary; newly authored files still appear before commit.
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).decode().split('\0')
    result = []
    for name in sorted(set(filter(None, names))):
        path = Path(name)
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
            raise ValueError('Symlink in public tree: ' + name)
        if not path.exists():
            continue  # Tracked deletion awaiting review.
        if not path.is_file() or path.is_absolute() or '..' in path.parts:
            raise ValueError('Unsafe public entry: ' + name)
        if any(part in {'.private', '.git', '.wrangler', '.terraform', 'node_modules'} for part in path.parts) or name.endswith(('.tfstate', '.tfplan', '.age', '.bundle', '.env')) or ('.dev.vars' in name and not name.endswith('.example')):
            raise ValueError('Private artifact tracked for publication: ' + name)
        result.append(path)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--identifiers', type=Path, help='Private JSON array of deployment identifiers; never commit this file')
    parser.add_argument('--export', type=Path, help='Create a NEW directory of checked files, without .git')
    args = parser.parse_args()
    identifiers = json.loads(args.identifiers.read_text()) if args.identifiers else []
    if not isinstance(identifiers, list) or not all(isinstance(x, str) for x in identifiers):
        raise ValueError('Identifier file must contain a JSON string array')
    files = public_files()
    errors = [(str(path), findings(path.read_bytes(), identifiers)) for path in files]
    errors = [(name, reasons) for name, reasons in errors if reasons]
    if errors:
        for name, reasons in errors:
            print(name + ': ' + ', '.join(reasons))  # Never echo secret values.
        return 1
    if args.export:
        args.export.mkdir(parents=True, exist_ok=False)
        for path in files:
            target = args.export / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            target.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
    print(f'Checked {len(files)} public files. No matching sensitive values found; manual binary/history review is still required.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
