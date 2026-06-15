"""Unit tests for the MinerU lazy-lifecycle state machine.

Pure logic, no I/O - the clock is injected so idle timeouts are deterministic.
Run: python -m pytest docker/mineru/test_lifecycle.py
"""

from lifecycle import LifecycleController


def test_first_request_signals_start_when_child_not_running():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    assert ctl.running is False
    # a real request arriving while the child is down must signal a (re)start
    assert ctl.begin_request(now=1.0) is True
    assert ctl.in_flight == 1


def test_request_does_not_signal_start_when_already_running():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    ctl.begin_request(now=1.0)
    ctl.mark_started()
    # a second request while the child is up does not ask for another start
    assert ctl.begin_request(now=2.0) is False
    assert ctl.in_flight == 2


def test_no_shutdown_while_requests_in_flight_even_past_timeout():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    ctl.begin_request(now=0.0)
    ctl.mark_started()
    # long past the idle window, but a request is still running -> never kill
    assert ctl.should_shutdown(now=10_000.0) is False


def test_no_shutdown_before_idle_timeout_elapses():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    ctl.begin_request(now=0.0)
    ctl.mark_started()
    ctl.end_request(now=1.0)
    assert ctl.should_shutdown(now=1.0 + 299.0) is False   # 299s idle < 300s


def test_shutdown_once_idle_timeout_elapses_with_no_in_flight():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    ctl.begin_request(now=0.0)
    ctl.mark_started()
    ctl.end_request(now=1.0)
    assert ctl.should_shutdown(now=1.0 + 300.0) is True     # exactly at the boundary


def test_no_shutdown_when_child_already_stopped():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    # never started -> nothing to shut down (avoids redundant kill attempts)
    assert ctl.should_shutdown(now=10_000.0) is False


def test_end_request_resets_the_idle_clock():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    ctl.begin_request(now=0.0)
    ctl.mark_started()
    # a request that finishes late must reset idle from its completion, not start
    ctl.end_request(now=1000.0)
    assert ctl.should_shutdown(now=1000.0 + 299.0) is False
    assert ctl.should_shutdown(now=1000.0 + 300.0) is True


def test_in_flight_never_goes_negative():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    ctl.end_request(now=1.0)        # stray end (defensive) must not underflow
    assert ctl.in_flight == 0


def test_concurrent_requests_counted_and_drain():
    ctl = LifecycleController(idle_timeout=300, now=0.0)
    ctl.begin_request(now=0.0)
    ctl.begin_request(now=0.0)
    ctl.mark_started()
    ctl.end_request(now=5.0)
    assert ctl.in_flight == 1
    assert ctl.should_shutdown(now=5.0 + 300.0) is False     # one still in flight
    ctl.end_request(now=6.0)
    assert ctl.in_flight == 0
    assert ctl.should_shutdown(now=6.0 + 300.0) is True
