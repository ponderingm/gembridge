import os
import logging
import base64
import requests
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks
from pydantic import BaseModel
from datetime import datetime

# Logging setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI()

# Configuration
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

# In-memory Job Queue
# Structure: { "id": str, "prompt": str, "status": "pending" | "processing" | "completed" | "failed", "created_at": datetime }
job_queue: List[Dict[str, Any]] = []

class JobRequest(BaseModel):
    prompt: str

class ErrorReport(BaseModel):
    message: str
    stack_trace: Optional[str] = None

def send_discord_notification(content: str, file: Optional[UploadFile] = None):
    if not DISCORD_WEBHOOK_URL:
        logger.warning("DISCORD_WEBHOOK_URL is not set. Skipping notification.")
        return

    try:
        data = {"content": content}
        files = {}
        if file:
            # Reset file pointer to beginning
            file.file.seek(0)
            files = {"file": (file.filename, file.file, file.content_type)}
            response = requests.post(DISCORD_WEBHOOK_URL, data=data, files=files)
        else:
            response = requests.post(DISCORD_WEBHOOK_URL, json=data)
        
        response.raise_for_status()
        logger.info("Discord notification sent successfully.")
    except Exception as e:
        logger.error(f"Failed to send Discord notification: {e}")

@app.post("/api/job")
async def create_job(job: JobRequest):
    new_job = {
        "id": str(len(job_queue) + 1), # Simple ID generation
        "prompt": job.prompt,
        "status": "pending",
        "created_at": datetime.now()
    }
    job_queue.append(new_job)
    logger.info(f"Job created: {new_job['id']} - {new_job['prompt']}")
    return {"job_id": new_job["id"], "status": "queued"}

@app.get("/api/job")
async def get_job():
    # Find the first pending job
    for job in job_queue:
        if job["status"] == "pending":
            job["status"] = "processing"
            logger.info(f"Job picked up: {job['id']}")
            return job
    return {"status": "empty"}

@app.post("/api/result")
async def report_result(
    background_tasks: BackgroundTasks,
    job_id: str = Form(...),
    prompt: str = Form(...),
    image: UploadFile = File(...)
):
    logger.info(f"Result received for job {job_id}")
    
    # Update job status
    for job in job_queue:
        if job["id"] == job_id:
            job["status"] = "completed"
            break
    
    # Send to Discord
    message = f"**Image Generated!**\n**Prompt:** {prompt}"
    background_tasks.add_task(send_discord_notification, message, image)
    
    return {"status": "received"}

@app.post("/api/error")
async def report_error(error: ErrorReport, background_tasks: BackgroundTasks):
    logger.error(f"Client reported error: {error.message}")
    
    message = f"⚠️ **Error Reported**\n{error.message}"
    if error.stack_trace:
        message += f"\n```\n{error.stack_trace}\n```"
    
    background_tasks.add_task(send_discord_notification, message)
    return {"status": "logged"}

@app.get("/health")
async def health_check():
    return {"status": "ok"}
