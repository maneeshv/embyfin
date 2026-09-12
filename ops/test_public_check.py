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


if __name__ == '__main__':
    unittest.main()
