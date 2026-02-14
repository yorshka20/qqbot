import runpod
import subprocess
import time
import requests
import json
import base64
import os
import sys
import uuid

COMFYUI_PATH = "/workspace/ComfyUI"
COMFYUI_URL = "http://127.0.0.1:8188"
POLL_INTERVAL = 0.5
TIMEOUT = 600  # 10分钟，视频生成慢

comfyui_process = None


def start_comfyui():
    global comfyui_process
    cmd = [
        sys.executable, "main.py",
        "--listen", "127.0.0.1",
        "--port", "8188",
        "--extra-model-paths-config", "/extra_model_paths.yaml",
        "--disable-auto-launch",
        "--disable-metadata",
    ]
    comfyui_process = subprocess.Popen(
        cmd,
        cwd=COMFYUI_PATH,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    print("Starting ComfyUI...")


def wait_for_comfyui(timeout=120):
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(f"{COMFYUI_URL}/system_stats", timeout=5)
            if r.status_code == 200:
                print("ComfyUI is ready.")
                return True
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("ComfyUI failed to start within timeout")


def upload_image(image_b64: str, filename: str):
    """base64 图片上传到 ComfyUI input 目录"""
    # 去掉 data URI 前缀
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    image_data = base64.b64decode(image_b64)
    files = {"image": (filename, image_data, "image/jpeg")}
    data = {"overwrite": "true"}
    r = requests.post(f"{COMFYUI_URL}/upload/image", files=files, data=data)
    r.raise_for_status()
    return r.json()["name"]


def queue_prompt(workflow: dict) -> str:
    """提交 workflow，返回 prompt_id"""
    client_id = str(uuid.uuid4())
    payload = {"prompt": workflow, "client_id": client_id}
    r = requests.post(f"{COMFYUI_URL}/prompt", json=payload)
    r.raise_for_status()
    return r.json()["prompt_id"]


def wait_for_result(prompt_id: str, timeout: int = TIMEOUT):
    """轮询直到任务完成，返回 history"""
    start = time.time()
    while time.time() - start < timeout:
        r = requests.get(f"{COMFYUI_URL}/history/{prompt_id}")
        if r.status_code == 200:
            history = r.json()
            if prompt_id in history:
                return history[prompt_id]
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"Job {prompt_id} timed out after {timeout}s")


def collect_outputs(history: dict) -> list:
    """从 history 里收集所有输出文件，返回 base64 列表"""
    outputs = []
    output_dir = os.path.join(COMFYUI_PATH, "output")

    for node_id, node_output in history.get("outputs", {}).items():
        # 图片
        for img in node_output.get("images", []):
            filepath = os.path.join(output_dir, img.get("subfolder", ""), img["filename"])
            if os.path.exists(filepath):
                with open(filepath, "rb") as f:
                    outputs.append({
                        "filename": img["filename"],
                        "type": "base64",
                        "format": "image/png",
                        "data": base64.b64encode(f.read()).decode("utf-8"),
                    })

        # 视频
        for vid in node_output.get("videos", []):
            filepath = os.path.join(output_dir, vid.get("subfolder", ""), vid["filename"])
            if os.path.exists(filepath):
                with open(filepath, "rb") as f:
                    outputs.append({
                        "filename": vid["filename"],
                        "type": "base64",
                        "format": "video/mp4",
                        "data": base64.b64encode(f.read()).decode("utf-8"),
                    })

    return outputs


def handler(job):
    job_input = job.get("input", {})
    workflow = job_input.get("workflow")
    if not workflow:
        return {"error": "Missing 'workflow' in input"}

    # 处理输入图片
    images = job_input.get("images", [])
    for img_obj in images:
        filename = img_obj.get("name", "input_image.jpg")
        b64 = img_obj.get("image", "")
        uploaded_name = upload_image(b64, filename)
        # 把 workflow 里 LoadImage 节点的文件名替换成上传后的名字
        for node in workflow.values():
            if isinstance(node, dict):
                if node.get("class_type") == "LoadImage":
                    inputs = node.get("inputs", {})
                    if inputs.get("image") == filename or inputs.get("image") == "input_image.jpg":
                        inputs["image"] = uploaded_name

    try:
        prompt_id = queue_prompt(workflow)
        print(f"Queued prompt: {prompt_id}")
        history = wait_for_result(prompt_id)
        outputs = collect_outputs(history)
        return {"outputs": outputs}
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    start_comfyui()
    wait_for_comfyui()
    runpod.serverless.start({"handler": handler})
