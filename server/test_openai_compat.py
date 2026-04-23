import asyncio
import subprocess
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from main import ChatCompletionsRequest, create_chat_completion


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
        self.assertEqual(context.exception.detail, "Gemini CLI failed")

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


if __name__ == "__main__":
    unittest.main()
