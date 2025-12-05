import os
import logging
import base64
import shutil
import requests
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from datetime import datetime

# Logging setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI()

# Configuration
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
DATA_DIR = "/app/data"
IMAGES_DIR = os.path.join(DATA_DIR, "images")

# Ensure directories exist
os.makedirs(IMAGES_DIR, exist_ok=True)

# Mount static files
app.mount("/images", StaticFiles(directory=IMAGES_DIR), name="images")

# In-memory Job Queue
# Structure: { "id": str, "prompt": str, "status": "pending" | "processing" | "completed" | "failed", "result_url": str, "created_at": datetime }
job_queue: List[Dict[str, Any]] = []

class JobRequest(BaseModel):
    prompt: str

class ErrorReport(BaseModel):
    message: str
    stack_trace: Optional[str] = None

def send_discord_notification(content: str, file_path: Optional[str] = None):
    if not DISCORD_WEBHOOK_URL:
        logger.warning("DISCORD_WEBHOOK_URL is not set. Skipping notification.")
        return

    try:
        data = {"content": content}
        files = {}
        if file_path:
            with open(file_path, "rb") as f:
                files = {"file": (os.path.basename(file_path), f, "image/png")}
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
        "result_url": None,
        "created_at": datetime.now()
    }
    job_queue.append(new_job)
    logger.info(f"Job created: {new_job['id']} - {new_job['prompt']}")
    return {"job_id": new_job["id"], "status": "queued"}

@app.get("/api/job")
async def get_job(job_id: Optional[str] = None):
    # If job_id is provided, return specific job status
    if job_id:
        for job in job_queue:
            if job["id"] == job_id:
                response = job.copy()
                if job["status"] == "completed" and job.get("result_url"):
                    # Extract filename from URL or use ID
                    file_path = os.path.join(IMAGES_DIR, f"{job['id']}.png")
                    if os.path.exists(file_path):
                        try:
                            with open(file_path, "rb") as img_file:
                                b64_string = base64.b64encode(img_file.read()).decode('utf-8')
                                response["image"] = b64_string
                        except Exception as e:
                            logger.error(f"Failed to encode image for job {job_id}: {e}")
                return response
        raise HTTPException(status_code=404, detail="Job not found")

    # Otherwise, find the first pending job (Worker polling)
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
    
    # Save image to disk
    file_path = os.path.join(IMAGES_DIR, f"{job_id}.png")
    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(image.file, buffer)
        logger.info(f"Image saved to {file_path}")
    except Exception as e:
        logger.error(f"Failed to save image: {e}")
        raise HTTPException(status_code=500, detail="Failed to save image")

    # Generate Public URL (Assuming standard port 8000, can be improved with env var)
    # Note: In production, this should be the external URL.
    result_url = f"/images/{job_id}.png"

    # Update job status
    for job in job_queue:
        if job["id"] == job_id:
            job["status"] = "completed"
            job["result_url"] = result_url
            break
    
    # Send to Discord
    message = f"**Image Generated!**\n**Prompt:** {prompt}\n**URL:** {result_url}"
    background_tasks.add_task(send_discord_notification, message, file_path)
    
    return {"status": "received", "url": result_url}

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
