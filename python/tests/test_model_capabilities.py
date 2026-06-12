from scout.model_capabilities import model_vision_support


def test_explicit_vision_override_is_authoritative():
    assert model_vision_support("local/model", {"local/model": {"vision": True}}) == "supported"
    assert model_vision_support("local/model", {"local/model": {"vision": False}}) == "unsupported"


def test_unknown_model_fails_closed(monkeypatch):
    monkeypatch.setattr("litellm.get_model_info", lambda **_: (_ for _ in ()).throw(KeyError()))
    assert model_vision_support("local/unknown") == "unverified"
