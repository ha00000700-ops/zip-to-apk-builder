import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

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
        error: "GitHub server configuration is missing"
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

    const fileName = "zipapk-build.zip";

    // Upload ZIP to GitHub repository
    const uploadUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${fileName}`;

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
      console.error("GitHub upload error:", uploadData);

      return res.status(uploadResponse.status).json({
        error: "Failed to upload ZIP to GitHub",
        details: uploadData.message
      });
    }

    // Find workflow
    const workflowUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows`;

    const workflowResponse = await fetch(workflowUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    const workflowData = await workflowResponse.json();

    if (!workflowResponse.ok) {
      return res.status(workflowResponse.status).json({
        error: "Unable to access GitHub Actions"
      });
    }

    const workflow = workflowData.workflows?.find(
      w =>
        w.path === `.github/workflows/${GITHUB_WORKFLOW}` ||
        w.name === "Build Android APK"
    );

    if (!workflow) {
      return res.status(404).json({
