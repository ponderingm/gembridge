import asyncio
import os
import subprocess
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from main import ChatCompletionsRequest, create_chat_completion, run_gemini_cli


class OpenAICompatApiTest(unittest.TestCase):
    @patch("main.run_gemini_cli")
    def test_chat_completions_returns_openai_compatible_response(self, mock_run_gemini_cli):
        mock_run_gemini_cli.return_value = "Hello from Gemini"
        request = ChatCompletionsRequest(
            model="gemini-2.5-flash",
            messages=[
                {"role": "system", "content": "You are helpful"},
                {"role": "user", "content": "こんにちは"}
            ]
        )

        body = asyncio.run(create_chat_completion(request))
        self.assertEqual(body["object"], "chat.completion")
        self.assertEqual(body["model"], "gemini-2.5-flash")
        self.assertEqual(body["choices"][0]["message"]["role"], "assistant")
        self.assertEqual(body["choices"][0]["message"]["content"], "Hello from Gemini")
        mock_run_gemini_cli.assert_called_once()

    @patch("main.run_gemini_cli")
    def test_chat_completions_returns_502_when_cli_fails(self, mock_run_gemini_cli):
        mock_run_gemini_cli.side_effect = subprocess.CalledProcessError(1, ["gemini"], stderr="boom")
        request = ChatCompletionsRequest(
            messages=[{"role": "user", "content": "test"}]
        )

        with self.assertRaises(HTTPException) as context:
            asyncio.run(create_chat_completion(request))

        self.assertEqual(context.exception.status_code, 502)
        self.assertEqual(context.exception.detail, "Gemini CLI の実行に失敗しました")

    @patch("main.run_gemini_cli")
    def test_chat_completions_returns_503_when_cli_not_found(self, mock_run_gemini_cli):
        mock_run_gemini_cli.side_effect = FileNotFoundError()
        request = ChatCompletionsRequest(messages=[{"role": "user", "content": "test"}])

        with self.assertRaises(HTTPException) as context:
            asyncio.run(create_chat_completion(request))

        self.assertEqual(context.exception.status_code, 503)

    @patch("main.run_gemini_cli")
    def test_chat_completions_returns_504_when_cli_times_out(self, mock_run_gemini_cli):
        mock_run_gemini_cli.side_effect = subprocess.TimeoutExpired(cmd=["gemini"], timeout=120)
        request = ChatCompletionsRequest(messages=[{"role": "user", "content": "test"}])

        with self.assertRaises(HTTPException) as context:
            asyncio.run(create_chat_completion(request))

        self.assertEqual(context.exception.status_code, 504)

    def test_chat_completions_returns_400_for_unsupported_role(self):
        request = ChatCompletionsRequest(messages=[{"role": "tool", "content": "test"}])
        with self.assertRaises(HTTPException) as context:
            asyncio.run(create_chat_completion(request))
        self.assertEqual(context.exception.status_code, 400)

    def test_chat_completions_returns_400_for_empty_content(self):
        request = ChatCompletionsRequest(messages=[{"role": "user", "content": "   "}])
        with self.assertRaises(HTTPException) as context:
            asyncio.run(create_chat_completion(request))
        self.assertEqual(context.exception.status_code, 400)

    def test_run_gemini_cli_returns_400_when_prompt_contains_null_byte(self):
        with self.assertRaises(HTTPException) as context:
            run_gemini_cli("abc\x00def", None)
        self.assertEqual(context.exception.status_code, 400)

    @patch("main.subprocess.run")
    def test_run_gemini_cli_uses_default_timeout_when_env_is_invalid(self, mock_run):
        mock_run.return_value = subprocess.CompletedProcess(args=["gemini"], returncode=0, stdout="ok", stderr="")
        with patch.dict(os.environ, {"GEMINI_CLI_TIMEOUT_SECONDS": "abc"}, clear=False):
            run_gemini_cli("prompt", None)
        self.assertEqual(mock_run.call_args.kwargs["timeout"], 120)

    @patch("main.subprocess.run")
    def test_run_gemini_cli_uses_default_timeout_when_env_is_non_positive(self, mock_run):
        mock_run.return_value = subprocess.CompletedProcess(args=["gemini"], returncode=0, stdout="ok", stderr="")
        with patch.dict(os.environ, {"GEMINI_CLI_TIMEOUT_SECONDS": "-1"}, clear=False):
            run_gemini_cli("prompt", None)
        self.assertEqual(mock_run.call_args.kwargs["timeout"], 120)


if __name__ == "__main__":
    unittest.main()
