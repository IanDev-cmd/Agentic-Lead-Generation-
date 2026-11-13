"""Free-tier model fallback. No network and no google-genai install required."""

from __future__ import annotations

import os
import unittest

from fallback.models import FREE_TIER_MODELS, generate_with_fallback, http_status, model_chain


class ApiError(Exception):
    def __init__(self, code: int, message: str = "") -> None:
        super().__init__(message or f'{{"error":{{"code":{code}}}}}')
        self.code = code


class Config:
    def __init__(self, tools=None, temperature: float = 0) -> None:
        self.tools = tools
        self.temperature = temperature

    def model_copy(self, update=None):
        copied = Config(self.tools, self.temperature)
        for key, value in (update or {}).items():
            setattr(copied, key, value)
        return copied


class FakeModels:
    def __init__(self, handler) -> None:
        self.handler = handler
        self.calls = []

    def generate_content(self, *, model, contents, config):
        self.calls.append((model, contents, getattr(config, "tools", None)))
        return self.handler(model, contents, config)


class FakeClient:
    def __init__(self, handler) -> None:
        self.models = FakeModels(handler)


class ModelFallbackTest(unittest.TestCase):
    def test_chain_order_and_legacy_model(self) -> None:
        self.assertEqual(model_chain("gemini-2.5-flash"), list(FREE_TIER_MODELS))
        self.assertEqual(model_chain(""), list(FREE_TIER_MODELS))
        self.assertEqual(
            model_chain("gemini-3.5-flash-lite"),
            ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemma-4-27b-it"],
        )
        self.assertEqual(len(FREE_TIER_MODELS), 6)

    def test_status_from_the_retired_model_body(self) -> None:
        exc = ApiError(
            0,
            '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users."}}',
        )
        exc.code = None
        self.assertEqual(http_status(exc), 404)
        self.assertEqual(http_status(ApiError(503)), 503)
        self.assertEqual(http_status(ApiError(401)), 401)

    def test_unavailable_models_keep_the_same_request(self) -> None:
        contents = "find buyers"

        def handler(model, _contents, config):
            self.assertEqual(config.tools, ["search"])
            if model == "gemini-3.8-flash":
                raise ApiError(404)
            if model == "gemini-3.7-flash":
                raise ApiError(429)
            if model == "gemini-3.6-flash":
                raise ApiError(503)
            return {"text": "ok"}

        client = FakeClient(handler)
        with self.assertLogs("fallback.models", level="WARNING") as logs:
            response = generate_with_fallback(
                client,
                contents=contents,
                config=Config(tools=["search"]),
                model="gemini-2.5-flash",
            )
        self.assertEqual(response, {"text": "ok"})
        self.assertEqual(
            [call[0] for call in client.models.calls],
            ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
        )
        self.assertTrue(all(call[1] == contents for call in client.models.calls))
        self.assertIn("gemini-3.8-flash", " ".join(logs.output))
        self.assertIn("404", " ".join(logs.output))

    def test_auth_and_primary_bad_request_stop(self) -> None:
        client = FakeClient(lambda *_args: (_ for _ in ()).throw(ApiError(403)))
        with self.assertRaises(ApiError) as caught:
            generate_with_fallback(client, contents="lead", config=Config(), model="gemini-3.8-flash")
        self.assertEqual(caught.exception.code, 403)
        self.assertEqual(len(client.models.calls), 1)

        client = FakeClient(lambda *_args: (_ for _ in ()).throw(ApiError(400)))
        with self.assertRaises(ApiError) as caught:
            generate_with_fallback(
                client,
                contents="lead",
                config=Config(tools=["search"]),
                models=list(FREE_TIER_MODELS),
            )
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(len(client.models.calls), 1)

    def test_fallback_model_retries_without_tools(self) -> None:
        def handler(model, _contents, config):
            if model == "gemini-3.8-flash":
                raise ApiError(503)
            if config.tools:
                raise ApiError(400)
            return {"text": "ungrounded"}

        client = FakeClient(handler)
        response = generate_with_fallback(
            client,
            contents="same request",
            config=Config(tools=["search"], temperature=1),
        )
        self.assertEqual(response, {"text": "ungrounded"})
        self.assertEqual(
            [(call[0], call[2]) for call in client.models.calls],
            [
                ("gemini-3.8-flash", ["search"]),
                ("gemini-3.7-flash", ["search"]),
                ("gemini-3.7-flash", None),
            ],
        )

    def test_env_model_is_still_read(self) -> None:
        previous = os.environ.get("FREE_MODEL")
        os.environ["FREE_MODEL"] = "gemma-4-27b-it"
        try:
            self.assertEqual(model_chain(None), ["gemma-4-27b-it"])
        finally:
            if previous is None:
                os.environ.pop("FREE_MODEL", None)
            else:
                os.environ["FREE_MODEL"] = previous


if __name__ == "__main__":
    unittest.main()
