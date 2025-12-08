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

import asyncio
import json
import yaml

# In-memory Job Queue
# Structure: { "id": str, "prompt": str, "status": "pending" | "processing" | "completed" | "failed", "result_url": str, "created_at": datetime }
job_queue: List[Dict[str, Any]] = []
queue_lock = asyncio.Lock()
last_worker_activity: datetime = datetime.now()

class JobRequest(BaseModel):
    prompt: Optional[str] = None
    data: Optional[Dict[str, Any]] = None

class ProgressReport(BaseModel):
    job_id: str
    status: str

class ErrorReport(BaseModel):
    message: str
    stack_trace: Optional[str] = None
    url: Optional[str] = None

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
    final_prompt = ""

    # 1. Structured Data Approach
    if job.data:
        try:
            yaml_string = yaml.dump(job.data, allow_unicode=True, default_flow_style=False, sort_keys=False)
            if job.prompt:
                final_prompt = f"{job.prompt}\n{yaml_string}"
            else:
                final_prompt = yaml_string
            logger.info("Converted structured data to YAML.")
        except Exception as e:
            logger.error(f"Failed to convert data to YAML: {e}")
            final_prompt = job.prompt or "" # Fallback
            
    # 2. Legacy String Approach (Backward Compatibility)
    elif job.prompt:
        prompt_content = job.prompt
        # Try to parse JSON and convert to YAML for better readability
        # Also handle "Generate Image: {...}" prefix extraction roughly
        import re
        match = re.search(r'^(.*?)\s*({.*})\s*$', prompt_content, re.DOTALL)
        
        try:
            if match:
                prefix = match.group(1)
                json_str = match.group(2)
                json_obj = json.loads(json_str)
                yaml_string = yaml.dump(json_obj, allow_unicode=True, default_flow_style=False, sort_keys=False)
                final_prompt = f"{prefix}\n{yaml_string}" if prefix.strip() else yaml_string
                logger.info("Converted embedded JSON to YAML.")
            else:
                 # Direct JSON check
                json_obj = json.loads(prompt_content)
                final_prompt = yaml.dump(json_obj, allow_unicode=True, default_flow_style=False, sort_keys=False)
                logger.info("Converted JSON string to YAML.")
        except (json.JSONDecodeError, AttributeError):
            # Not a JSON string or structure, keep as is
            final_prompt = prompt_content
        except Exception as e:
             logger.warning(f"Failed to convert legacy prompt: {e}")
             final_prompt = prompt_content
    
    else:
        raise HTTPException(status_code=400, detail="Prompt or data is required")

    new_job = {
        "id": str(len(job_queue) + 1), # Simple ID generation
        "prompt": final_prompt,
        "status": "pending",
        "detailed_status": "Queued",
        "result_url": None,
        "created_at": datetime.now()
    }
    job_queue.append(new_job)
    logger.info(f"Job created: {new_job['id']} - {new_job['prompt'][:50]}...")
    return {"job_id": new_job["id"], "status": "queued"}

@app.get("/api/job")
async def get_job(job_id: Optional[str] = None, busy: bool = False):
    global last_worker_activity

    # If job_id is provided, return specific job status
    if job_id:
        # Check for worker timeout (10s = 2 * 5s polling interval)
        if (datetime.now() - last_worker_activity).total_seconds() > 10:
            # Check if we have already notified for this timeout
            # We don't want to spam Discord, so maybe check a flag or just rely on the job fail?
            # But the requirement is to notify.
            # Let's check if there are pending jobs that are now failing.
            
            jobs_failed = False
            for job in job_queue:
                if job["id"] == job_id and job["status"] in ["pending", "processing"]:
                    job["status"] = "failed"
                    job["error"] = "Worker timeout (Userscript not active)"
                    job["detailed_status"] = "Timeout"
                    logger.error(f"Job {job_id} failed due to worker timeout")
                    jobs_failed = True
            
            if jobs_failed:
                background_tasks = BackgroundTasks() # We need to inject this or run sync.
                # Since we are in a GET, we can't easily inject BackgroundTasks without changing signature and handling it.
                # But we can just run it synchronously or use a helper. 
                # Let's just log and maybe send notification if we can. 
                # Ideally get_job should just return status. 
                # But let's fire and forget for now in a non-blocking way if possible, or just call it.
                # send_discord_notification is blocking (requests).
                # better to spawn a thread or just do it.
                try:
                     send_discord_notification(f"⚠️ **Worker Timeout Detected**\nJob {job_id} failed because the Userscript worker has been inactive for > 10s.")
                except:
                    pass

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
    async with queue_lock:
        last_worker_activity = datetime.now()
        if busy:
            return {"status": "busy"}

        # 1. Zombie Recovery & Stale Job Reset
        now = datetime.now()
        for job in job_queue:
            if job["status"] == "processing":
                # A. Zombie Recovery: Idle worker asking for work while job is processing
                # If we are here (busy=False), it means the worker is free.
                # If there is a processing job, the worker likely dropped it.
                # Use a small grace period (e.g. 5s) to avoid race conditions where the worker *just* took it.
                updated_at = job.get("updated_at")
                if updated_at:
                    elapsed = (now - updated_at).total_seconds()
                    
                    # If job is merely "Picked up" but stuck for > 30s, reset it.
                    if job.get("detailed_status") == "Picked up by worker" and elapsed > 30:
                         job["status"] = "pending"
                         job["updated_at"] = now
                         logger.warning(f"Resetting stuck job (Picked up state): {job['id']}")
                         continue

                    # If > 120s total processing time, reset it (Stale check)
                    if elapsed > 120: 
                        job["status"] = "pending"
                        job["updated_at"] = now
                        logger.warning(f"Resetting stale job (>120s): {job['id']}")
                        continue

                    # B. Active Zombie Recovery
                    # If the worker is polling (IDLE) and the job is processing, 
                    # and enough time (e.g. > 5s) has passed since it was picked up:
                    # It implies the worker doesn't know it should be working on this.
                    if elapsed > 5:
                        logger.warning(f"Zombie job detected: {job['id']}. Re-sending to idle worker.")
                        job["updated_at"] = datetime.now() # Reset timeout
                        return job
        
        # Find pending job
        for job in job_queue:
            if job["status"] == "pending":
                job["status"] = "processing"
                job["detailed_status"] = "Picked up by worker"
                job["updated_at"] = datetime.now()
                logger.info(f"Job picked up: {job['id']}")
                return job
    return {"status": "empty"}

@app.post("/api/progress")
async def report_progress(report: ProgressReport):
    global last_worker_activity
    async with queue_lock:
        last_worker_activity = datetime.now()
        for job in job_queue:
            if job["id"] == report.job_id:
                job["detailed_status"] = report.status
                job["updated_at"] = datetime.now()
                logger.info(f"Job {report.job_id} progress: {report.status}")
                return {"status": "updated"}
    return {"status": "job_not_found"}

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
            job["detailed_status"] = "Completed"
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
    if error.url:
         message += f"\n**URL:** {error.url}"
    
    background_tasks.add_task(send_discord_notification, message)
    return {"status": "logged"}

@app.get("/health")
async def health_check():
    return {"status": "ok"}
