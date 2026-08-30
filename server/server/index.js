import express from "express";
import multer from "multer";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO || "zip-to-apk-builder";
const GITHUB_WORKFLOW = process.env.GITHUB_WORKFLOW || "build-apk.yml";

const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ZIPAPK Build Server"
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

    const zipBuffer = fs.readFileSync(filePath);
    const base64Zip = zipBuffer.toString("base64");

    const uploadUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/zipapk-build.zip`;

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: "Upload ZIP for APK build",
        content: base64Zip
      })
    });

    const uploadData = await uploadResponse.json();

    if (!uploadResponse.ok) {
      return res.status(uploadResponse.status).json({
        error: "GitHub upload failed",
        details: uploadData.message
      });
    }

    const workflowsUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows`;

    const workflowsResponse = await fetch(workflowsUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    const workflowsData = await workflowsResponse.json();

    const workflow = workflowsData.workflows?.find(
      w =>
        w.path === `.github/workflows/${GITHUB_WORKFLOW}` ||
        w.name === "Build Android APK"
    );

    if (!workflow) {
      return res.status(404).json({
        error: "Build workflow not found"
      });
    }

    const dispatchUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflow.id}/dispatches`;

    const dispatchResponse = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: "main"
      })
    });

    if (!dispatchResponse.ok) {
      const errorText = await dispatchResponse.text();

      return res.status(dispatchResponse.status).json({
        error: "Failed to start GitHub Actions",
        details: errorText
      });
    }

    res.json({
      success: true,
      message: "Build started successfully"
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Build server error",
      details: error.message
    });

  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    server: "ZIPAPK"
  });
});

app.listen(PORT, () => {
  console.log(`ZIPAPK Build Server running on port ${PORT}`);
});
