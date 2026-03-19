"""
Gembridge Discord Bot

Discordスラッシュコマンドで Gembridge API を呼び出し、
T2I / I2I / マルチモーダル画像生成を行うボット。

環境変数:
  DISCORD_BOT_TOKEN  - Discord Bot トークン (必須)
  GEMBRIDGE_API_URL  - Gembridge API の URL (例: http://gemini-api:8000/api)
  POLL_INTERVAL      - ジョブポーリング間隔(秒) デフォルト 5
  POLL_TIMEOUT       - ポーリングタイムアウト(秒) デフォルト 300
"""

import os
import io
import base64
import asyncio
import logging
import aiohttp
import discord
from discord import app_commands

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Configuration
DISCORD_BOT_TOKEN = os.environ["DISCORD_BOT_TOKEN"]
GEMBRIDGE_API_URL = os.getenv("GEMBRIDGE_API_URL", "http://gemini-api:8000/api")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "5"))
POLL_TIMEOUT = int(os.getenv("POLL_TIMEOUT", "300"))

# Mode choices for slash commands
MODE_CHOICES = [
    app_commands.Choice(name="高速モード (high-speed)", value="high-speed"),
    app_commands.Choice(name="思考モード (thinking)", value="thinking"),
    app_commands.Choice(name="プロモード (pro)", value="pro"),
]


async def submit_job(
    session: aiohttp.ClientSession,
    prompt: str,
    mode: str,
    image_data: str | None = None,
) -> str:
    """Gembridge API にジョブを登録し、job_id を返す。"""
    payload: dict = {"prompt": prompt, "mode": mode}
    if image_data:
        payload["image_data"] = image_data

    async with session.post(f"{GEMBRIDGE_API_URL}/job", json=payload) as resp:
        resp.raise_for_status()
        data = await resp.json()
        return data["job_id"]


async def poll_job(
    session: aiohttp.ClientSession,
    job_id: str,
    interaction: discord.Interaction,
) -> bytes | None:
    """ジョブが完了するまでポーリングし、完了後は画像バイト列を返す。
    失敗・タイムアウト時は None を返す。
    """
    elapsed = 0
    last_status = ""

    while elapsed < POLL_TIMEOUT:
        await asyncio.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL

        try:
            async with session.get(
                f"{GEMBRIDGE_API_URL}/job", params={"job_id": job_id}
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
        except Exception as exc:
            logger.warning("Poll error for job %s: %s", job_id, exc)
            continue

        status = data.get("status", "")
        detailed = data.get("detailed_status", "")
        display_status = detailed or status

        # 進捗を Discord にフォローアップ通知(変化があった場合のみ)
        if display_status != last_status:
            last_status = display_status
            try:
                await interaction.edit_original_response(
                    content=f"⏳ 生成中… `{display_status}` (経過: {elapsed}s)"
                )
            except discord.NotFound:
                pass

        if status == "completed":
            raw = data.get("image")
            if raw:
                return base64.b64decode(raw)
            return None

        if status == "failed":
            error_msg = data.get("error", data.get("detailed_status", "Unknown error"))
            logger.error("Job %s failed: %s", job_id, error_msg)
            return None

    logger.error("Job %s timed out after %ss", job_id, POLL_TIMEOUT)
    return None


async def handle_generation(
    interaction: discord.Interaction,
    prompt: str,
    mode: str,
    image_data: str | None,
    label: str,
) -> None:
    """共通の画像生成ハンドラ。"""
    await interaction.response.defer(thinking=True)

    try:
        async with aiohttp.ClientSession() as session:
            # ジョブを登録
            try:
                job_id = await submit_job(session, prompt, mode, image_data)
            except Exception as exc:
                logger.error("Failed to submit job: %s", exc)
                await interaction.edit_original_response(
                    content=f"❌ ジョブの登録に失敗しました: `{exc}`"
                )
                return

            await interaction.edit_original_response(
                content=f"✅ **{label}** ジョブを登録しました (ID: `{job_id}`)\n"
                f"🔄 生成を待機中…"
            )

            # 完了まで待機
            image_bytes = await poll_job(session, job_id, interaction)

    except Exception as exc:
        logger.error("Unexpected error: %s", exc)
        await interaction.edit_original_response(
            content=f"❌ 予期しないエラーが発生しました: `{exc}`"
        )
        return

    if image_bytes is None:
        await interaction.edit_original_response(
            content=(
                f"❌ **{label}** 画像生成に失敗しました。\n"
                "Gembridge のログを確認してください。"
            )
        )
        return

    # 画像を Discord に送信
    file = discord.File(fp=io.BytesIO(image_bytes), filename="generated.png")
    mode_label = {"high-speed": "高速", "thinking": "思考", "pro": "プロ"}.get(mode, mode)
    await interaction.edit_original_response(
        content=(
            f"🎨 **{label}** 生成完了！\n"
            f"📝 プロンプト: `{prompt}`\n"
            f"⚙️ モード: `{mode_label}`"
        ),
        attachments=[file],
    )


# Discord client setup
intents = discord.Intents.default()
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)


@client.event
async def on_ready() -> None:
    await tree.sync()
    logger.info("Bot ready as %s (ID: %s)", client.user, client.user.id)


# ──────────────────────────────────────────────────────────────────────────────
# /t2i — Text to Image
# ──────────────────────────────────────────────────────────────────────────────
@tree.command(name="t2i", description="テキストから画像を生成します (Text to Image)")
@app_commands.describe(
    prompt="画像生成プロンプト",
    mode="生成モード",
)
@app_commands.choices(mode=MODE_CHOICES)
async def cmd_t2i(
    interaction: discord.Interaction,
    prompt: str,
    mode: app_commands.Choice[str] | None = None,
) -> None:
    selected_mode = mode.value if mode else "high-speed"
    await handle_generation(interaction, prompt, selected_mode, None, "T2I")


# ──────────────────────────────────────────────────────────────────────────────
# /i2i — Image to Image
# ──────────────────────────────────────────────────────────────────────────────
@tree.command(
    name="i2i",
    description="参照画像を添付してキャラクターの同一性を保ったまま画像を生成します (Image to Image)",
)
@app_commands.describe(
    prompt="画像生成プロンプト",
    image="参照画像 (PNG / JPG)",
    mode="生成モード",
)
@app_commands.choices(mode=MODE_CHOICES)
async def cmd_i2i(
    interaction: discord.Interaction,
    prompt: str,
    image: discord.Attachment,
    mode: app_commands.Choice[str] | None = None,
) -> None:
    selected_mode = mode.value if mode else "high-speed"

    # 添付画像をダウンロードして Base64 エンコード
    try:
        image_bytes = await image.read()
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
    except Exception as exc:
        await interaction.response.send_message(
            f"❌ 画像の読み込みに失敗しました: `{exc}`", ephemeral=True
        )
        return

    await handle_generation(interaction, prompt, selected_mode, image_b64, "I2I")


# ──────────────────────────────────────────────────────────────────────────────
# /multimodal — マルチモーダル生成
# ──────────────────────────────────────────────────────────────────────────────
@tree.command(
    name="multimodal",
    description="テキストと任意の参照画像を組み合わせてマルチモーダル画像生成を行います",
)
@app_commands.describe(
    prompt="画像生成プロンプト",
    image="参照画像 (任意 — 省略可)",
    mode="生成モード",
)
@app_commands.choices(mode=MODE_CHOICES)
async def cmd_multimodal(
    interaction: discord.Interaction,
    prompt: str,
    image: discord.Attachment | None = None,
    mode: app_commands.Choice[str] | None = None,
) -> None:
    selected_mode = mode.value if mode else "high-speed"

    image_b64: str | None = None
    if image:
        try:
            image_bytes = await image.read()
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        except Exception as exc:
            await interaction.response.send_message(
                f"❌ 画像の読み込みに失敗しました: `{exc}`", ephemeral=True
            )
            return

    await handle_generation(interaction, prompt, selected_mode, image_b64, "Multimodal")


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────
client.run(DISCORD_BOT_TOKEN, log_handler=None)
