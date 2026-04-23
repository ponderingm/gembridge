import asyncio
import os
import subprocess
import unittest
from unittest.mock import patch

from fastapi import HTTPException

os.environ["DATA_DIR"] = "/tmp/gembridge-test-data"

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
        self.assertIn("Gemini CLI failed", context.exception.detail)


if __name__ == "__main__":
    unittest.main()
