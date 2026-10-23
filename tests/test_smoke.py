import importlib.util
import os
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).resolve().parents[1] / 'scripts/smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class PortCleanupTests(unittest.TestCase):
    def test_listener_is_rejected_but_closed_connection_is_released(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(('127.0.0.1', 0))
            port = server.getsockname()[1]
            server.listen()
            with self.assertRaises(OSError):
                smoke.check_port_released(port)
            with socket.create_connection(('127.0.0.1', port)) as client:
                connection, _ = server.accept()
                with connection:
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b'')
                # The server actively closes, leaving a TIME_WAIT connection on Linux.
        smoke.check_port_released(port)


class SmokeSafetyTests(unittest.TestCase):
    def test_requires_disposable_host_before_creating_resources(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(smoke.tempfile, 'TemporaryDirectory') as temporary:
            with self.assertRaisesRegex(RuntimeError, 'PICCOVE_SMOKE_DISPOSABLE_HOST'):
                smoke.smoke(Path('/unused-bundle'), Path('/unused-work'))
            temporary.assert_not_called()
