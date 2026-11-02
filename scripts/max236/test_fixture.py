import unittest
from unittest.mock import patch
import fixture


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.h = dict(container_id='c', image='image', network_id='n', volume='v',
                      network='net', port=45678, volume_labels={'max236.nonce': 'nonce'})
        self.objects = {
            'container': dict(Id='c', Image='image', Config={'Labels': {'max236.nonce': 'nonce'}},
                              Mounts=[{'Name': 'v', 'Type': 'volume', 'Destination': '/var/lib/mysql'}], NetworkSettings={
                                  'Networks': {'net': {'NetworkID': 'n'}}, 'Ports': {'3306/tcp': [
                                      {'HostIp': '127.0.0.1', 'HostPort': '45678'}]}}),
            'network': dict(Id='n', Name='net', Labels={'max236.nonce': 'nonce'}),
            'volume': dict(Name='v', Labels={'max236.nonce': 'nonce'}),
        }

    def verify(self, stopped=False):
        with patch.object(fixture, 'inspect', side_effect=lambda kind, _: self.objects[kind]):
            fixture.verify(self.h, stopped=stopped)

    def test_exact_handle(self):
        self.verify()

    def test_replaced_container_refused(self):
        self.objects['container']['Id'] = 'neighbor'
        with self.assertRaises(AssertionError):
            self.verify()

    def test_foreign_nonce_refused(self):
        self.objects['volume']['Labels']['max236.nonce'] = 'neighbor'
        with self.assertRaises(AssertionError):
            self.verify()

    def test_remote_binding_refused(self):
        self.objects['container']['NetworkSettings']['Ports']['3306/tcp'][0]['HostIp'] = '0.0.0.0'
        with self.assertRaises(AssertionError):
            self.verify()

    def test_unknown_inspect_propagates(self):
        with patch.object(fixture, 'inspect', side_effect=RuntimeError('daemon unavailable')):
            with self.assertRaises(RuntimeError):
                fixture.verify(self.h)

    def test_foreign_network_id_refused(self):
        self.objects['container']['NetworkSettings']['Networks']['net']['NetworkID'] = 'foreign'
        with self.assertRaises(AssertionError):
            self.verify()

    def test_docker_calls_have_bounded_timeout(self):
        with patch.object(fixture.subprocess, 'check_output', return_value='ok') as run:
            fixture.docker('inspect', 'c')
            self.assertGreater(run.call_args.kwargs.get('timeout', 0), 0)
            self.assertLessEqual(run.call_args.kwargs['timeout'], 60)

    def stopped(self):
        self.objects['container'].update(State={'Running': False}, HostConfig={
            'NetworkMode':'net', 'PortBindings': {'3306/tcp': [{'HostIp':'127.0.0.1','HostPort':''}]}})
        self.objects['container']['NetworkSettings']['Networks']['net']['NetworkID'] = ''

    def test_prestart_unattached_network_requires_exact_intent(self):
        self.stopped()
        self.verify(stopped=True)
        self.objects['container']['HostConfig']['NetworkMode'] = 'foreign'
        with self.assertRaises(AssertionError):
            self.verify(stopped=True)

    def test_prestart_foreign_nonempty_id_is_refused(self):
        self.stopped()
        self.objects['container']['NetworkSettings']['Networks']['net']['NetworkID'] = 'foreign'
        with self.assertRaises(AssertionError):
            self.verify(stopped=True)

    def test_prestart_replaced_network_object_is_refused(self):
        self.stopped()
        self.objects['network']['Id'] = 'foreign'
        with self.assertRaises(AssertionError):
            self.verify(stopped=True)

    def test_prestart_foreign_mount_is_refused(self):
        self.stopped()
        self.objects['container']['Mounts'][0]['Name'] = 'neighbor'
        with self.assertRaises(AssertionError):
            self.verify(stopped=True)

    def test_prestart_running_container_is_refused(self):
        self.stopped()
        self.objects['container']['State']['Running'] = True
        with self.assertRaises(AssertionError):
            self.verify(stopped=True)


if __name__ == '__main__':
    unittest.main()
