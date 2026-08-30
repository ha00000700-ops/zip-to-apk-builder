import express from "express";
import multer from "multer";
import fs from "fs";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO || "zip-to-apk-builder";
const GITHUB_WORKFLOW = process.env.GITHUB_WORKFLOW || "build-apk.yml";

const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

const jobs = new Map();

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ZIPAPK Build Server"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    server: "ZIPAPK"
  });
});

app.post("/api/build", upload.single("zip"), async (req, res) => {
  let filePath = null;

  try {
    if (!GITHUB_TOKEN || !GITHUB_OWNER) {
      return res.status(500).json({
        error: "GitHub configuration is missing"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "ZIP file is required"
      });
    }

    filePath = req.file.path;

    const jobId = crypto.randomUUID();

    jobs.set(jobId, {
      jobId,
      status: "queued",
      createdAt: Date.now(),
      runId: null
    });

    // Read ZIP
    const zipBuffer = fs.readFileSync(filePath);
    const base64Zip = zipBuffer.toString("base64");

    // Upload ZIP to repository
    const zipPath = "zipapk-build.zip";

    const contentsUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${zipPath}`;

    // Check whether the ZIP already exists
    let sha;

    const existing = await fetch(contentsUrl, {
      headers: githubHeaders()
    });

    if (existing.ok) {
      const existingData = await existing.json();
      sha = existingData.sha;
    }

    const uploadBody = {
      message: `Upload ZIP for build ${jobId}`,
      content: base64Zip
    };

    if (sha) {
      uploadBody.sha = sha;
    }

    const uploadResponse = await fetch(contentsUrl, {
      method: "PUT",
      headers: {
        ...githubHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(uploadBody)
    });

    const uploadData = await uploadResponse.json();

    if (!uploadResponse.ok) {
      jobs.delete(jobId);

      return res.status(uploadResponse.status).json({
        error: "GitHub ZIP upload failed",
        details: uploadData.message
      });
    }

    jobs.get(jobId).status = "building";

    // Start GitHub Actions workflow
    const workflowUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`;

    const dispatchResponse = await fetch(workflowUrl, {
      method: "POST",
      headers: {
        ...githubHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: "main"
      })
    });

    if (!dispatchResponse.ok) {
      const errorText = await dispatchResponse.text();

      jobs.get(jobId).status = "failed";

      return res.status(dispatchResponse.status).json({
        error: "Failed to start GitHub Actions",
        details: errorText,
        jobId
      });
    }

    // Return the jobId expected by the Android application
    return res.status(202).json({
      jobId,
      status: "building",
      message: "Build started successfully"
    });

  } catch (error) {
   
