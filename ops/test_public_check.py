import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('public_check', Path(__file__).with_name('check-public.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class PublicCheckTest(unittest.TestCase):
    def test_sensitive_content_and_synthetic_examples(self):
        self.assertTrue(check.findings(b'prefix-private-host.invalid', ['private-host.invalid']))
        self.assertTrue(check.findings(('AGE-SECRET-' + 'KEY-' + 'A' * 59).encode()))
        self.assertTrue(check.findings(('CLOUDFLARE_API_TOKEN=' + 'a' * 40).encode()))
        self.assertTrue(check.findings(('account_id = "' + 'a' * 32 + '"').encode()))
        self.assertEqual(check.findings(b'account_id = "00000000000000000000000000000000"\nMACHINE_SECRET='), [])

    def test_symlinks_must_stay_inside_the_tree(self):
        import os, tempfile
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                Path('AGENTS.md').write_text('rules')
                os.symlink('AGENTS.md', 'CLAUDE.md')
                os.symlink('/etc/passwd', 'absolute')
                os.symlink('../outside', 'escape')
                os.symlink('missing', 'dangling')
                self.assertTrue(check.safe_link(Path('CLAUDE.md')))
                for name in ('absolute', 'escape', 'dangling'):
                    self.assertFalse(check.safe_link(Path(name)), name)
            finally:
                os.chdir(cwd)


if __name__ == '__main__':
    unittest.main()
