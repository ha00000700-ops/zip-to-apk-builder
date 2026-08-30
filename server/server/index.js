import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import unzipper from "unzipper";

const app = express();
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO || "zip-to-apk-builder";
const GITHUB_WORKFLOW = process.env.GITHUB_WORKFLOW || "build.yml";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

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

function getPublicBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto
    ? String(forwardedProto).split(",")[0]
    : req.protocol;

  const host = req.get("host");

  return `${protocol}://${host}`;
}

/* -------------------------------- */
/* Middleware                       */
/* -------------------------------- */

app.use(express.json());

/* -------------------------------- */
/* Health                           */
/* -------------------------------- */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ZIPAPK Build Server",
    status: "online"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    server: "ZIPAPK",
    status: "online"
  });
});

/* -------------------------------- */
/* Start Build                      */
/* -------------------------------- */

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

    const job = {
      jobId,
      status: "queued",
      stage: 1,
      stageName: "في انتظار البناء",
      createdAt: Date.now(),
      runId: null,
      apkUrl: null,
      artifactUrl: null,
      error: null
    };

    jobs.set(jobId, job);

    /* -------------------------------- */
    /* Upload ZIP to GitHub             */
    /* -------------------------------- */

    job.stage = 2;
    job.stageName = "رفع المشروع";
    job.status = "uploading";

    const zipBuffer = fs.readFileSync(filePath);
    const base64Zip = zipBuffer.toString("base64");

    const zipPath = "zipapk-build.zip";

    const contentsUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${zipPath}`;

    let sha = null;

    const existingResponse = await fetch(contentsUrl, {
      headers: githubHeaders()
    });

    if (existingResponse.ok) {
      const existingData = await existingResponse.json();
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

    const uploadText = await uploadResponse.text();

    let uploadData = {};

    try {
      uploadData = JSON.parse(uploadText);
    } catch {
      uploadData = {};
    }

    if (!uploadResponse.ok) {
      job.status = "failed";
      job.error =
        uploadData.message ||
        "GitHub ZIP upload failed";

      return res.status(uploadResponse.status).json({
        error: job.error,
        jobId
      });
    }

    /* -------------------------------- */
    /* Start GitHub Actions             */
    /* -------------------------------- */

    job.stage = 3;
    job.stageName = "تحضير Android";
    job.status = "starting";

    const workflowUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`;

    const dispatchTime = Date.now();

    const dispatchResponse = await fetch(workflowUrl, {
      method: "POST",
      headers: {
        ...githubHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: GITHUB_BRANCH
      })
    });

    if (!dispatchResponse.ok) {
      const errorText = await dispatchResponse.text();

      job.status = "failed";
      job.error = "Failed to start GitHub Actions";

      return res.status(dispatchResponse.status).json({
        error: job.error,
        details: errorText,
        jobId
      });
    }

    /* -------------------------------- */
    /* Find Workflow Run                */
    /* -------------------------------- */

    let run = null;

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const runsUrl =
          `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/runs` +
          `?branch=${encodeURIComponent(GITHUB_BRANCH)}` +
          `&event=workflow_dispatch&per_page=20`;

        const runsResponse = await fetch(runsUrl, {
          headers: githubHeaders()
        });

        if (runsResponse.ok) {
          const runsData = await runsResponse.json();

          const possibleRuns = (runsData.workflow_runs || [])
            .filter(r => {
              const created =
                new Date(r.created_at).getTime();

              return (
                created >= dispatchTime - 10000 &&
                r.event === "workflow_dispatch"
              );
            })
            .sort(
              (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
            );

          if (possibleRuns.length > 0) {
            run = possibleRuns[0];
            break;
          }
        }
      } catch (error) {
        console.error(
          "Run lookup error:",
          error.message
        );
      }

      await sleep(1500);
    }

    if (!run) {
      job.status = "failed";
      job.error =
        "GitHub workflow started but Run ID was not found";

      return res.status(500).json({
        error: job.error,
        jobId
      });
    }

    job.runId = run.id;
    job.status = "building";
    job.stage = 3;
    job.stageName = "تحضير Android";

    return res.status(202).json({
      jobId: job.jobId,
      runId: job.runId,
      status: "building",
      stage: job.stage,
      stageName: job.stageName,
      message: "Build started successfully"
    });

  } catch (error) {
    console.error("BUILD ERROR:", error);

    return res.status(500).json({
      error: "Build server error",
      details: error.message
    });

  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error(
          "Temporary file cleanup error:",
          error.message
        );
      }
    }
  }
});

/* -------------------------------- */
/* Get Build Status                 */
/* -------------------------------- */

app.get("/api/build/:jobId", async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found",
        jobId: req.params.jobId
      });
    }

    if (!job.runId) {
      return res.json({
        jobId: job.jobId,
        status: job.status,
        stage: job.stage,
        stageName: job.stageName,
        runId: null,
        apkUrl: null,
        downloadUrl: null,
        artifactUrl: null,
        apkAvailable: false,
        error: job.error
      });
    }

    /* -------------------------------- */
    /* Get GitHub Run                  */
    /* -------------------------------- */

    const runUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${job.runId}`;

    const runResponse = await fetch(runUrl, {
      headers: githubHeaders()
    });

    if (!runResponse.ok) {
      return res.json({
        jobId: job.jobId,
        status: job.status,
        stage: job.stage,
        stageName: job.stageName,
        runId: job.runId,
        apkUrl: null,
        downloadUrl: null,
        artifactUrl: job.artifactUrl,
        apkAvailable: false,
        error: job.error
      });
    }

    const run = await runResponse.json();

    /* -------------------------------- */
    /* Still Building                  */
    /* -------------------------------- */

    if (run.status !== "completed") {
      job.status = "building";

      try {
        const jobsUrl =
          `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${job.runId}/jobs?per_page=100`;

        const jobsResponse = await fetch(jobsUrl, {
          headers: githubHeaders()
        });

        if (jobsResponse.ok) {
          const jobsData = await jobsResponse.json();

          const githubJob =
            (jobsData.jobs || [])[0];

          if (githubJob) {
            const steps = githubJob.steps || [];

            const activeStep =
              steps.find(
                step =>
                  step.status === "in_progress"
              );

            const completedSteps =
              steps.filter(
                step =>
                  step.status === "completed" &&
                  step.conclusion === "success"
              );

            if (activeStep) {
              const name =
                activeStep.name.toLowerCase();

              if (
                name.includes("find zip") ||
                name.includes("extract zip") ||
                name.includes("upload")
              ) {
                job.stage = 2;
                job.stageName = "رفع المشروع";
              } else if (
                name.includes("android project") ||
                name.includes("gradle wrapper") ||
                name.includes("signing")
              ) {
                job.stage = 3;
                job.stageName = "تحضير Android";
              } else if (
                name.includes("setup gradle")
              ) {
                job.stage = 4;
                job.stageName = "تشغيل Gradle";
              } else if (
                name.includes("build debug apk")
              ) {
                job.stage = 5;
                job.stageName = "بناء APK";
              }
            } else if (completedSteps.length > 0) {
              job.stage = Math.min(
                5,
                Math.max(3, completedSteps.length)
              );
            }
          }
        }
      } catch (error) {
        console.error(
          "GitHub jobs lookup error:",
          error.message
        );
      }

      return res.json({
        jobId: job.jobId,
        status: job.status,
        stage: job.stage,
        stageName: job.stageName,
        runId: job.runId,
        apkUrl: null,
        downloadUrl: null,
        artifactUrl: null,
        apkAvailable: false,
        error: null
      });
    }

    /* -------------------------------- */
    /* Build Failed                    */
    /* -------------------------------- */

    if (run.conclusion !== "success") {
      job.status = "failed";
      job.stage = 5;
      job.stageName = "بناء APK";
      job.error =
        run.conclusion ||
        "GitHub build failed";

      return res.json({
        jobId: job.jobId,
        status: "failed",
        stage: job.stage,
        stageName: job.stageName,
        runId: job.runId,
        apkUrl: null,
        downloadUrl: null,
        artifactUrl: null,
        apkAvailable: false,
        error: job.error
      });
    }

    /* -------------------------------- */
    /* Build Successful                */
    /* -------------------------------- */

    job.status = "completed";
    job.stage = 6;
    job.stageName = "اكتمل";

    /* -------------------------------- */
    /* Find Artifact                   */
    /* -------------------------------- */

    const artifactsUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${job.runId}/artifacts`;

    const artifactsResponse =
      await fetch(artifactsUrl, {
        headers: githubHeaders()
      });

    if (!artifactsResponse.ok) {
      return res.status(500).json({
        jobId: job.jobId,
        status: "failed",
        stage: 6,
        stageName: "اكتمل",
        runId: job.runId,
        apkUrl: null,
        downloadUrl: null,
        artifactUrl: null,
        apkAvailable: false,
        error: "Unable to read GitHub artifact"
      });
    }

    const artifactsData =
      await artifactsResponse.json();

    const artifact =
      (artifactsData.artifacts || [])
        .find(
          a =>
            a.name === "app-debug" &&
            !a.expired
        );

    if (!artifact) {
      return res.json({
        jobId: job.jobId,
        status: "failed",
        stage: 6,
        stageName: "اكتمل لكن APK غير موجود",
        runId: job.runId,
        apkUrl: null,
        downloadUrl: null,
        artifactUrl: null,
        apkAvailable: false,
        error: "APK artifact was not found"
      });
    }

    job.artifactUrl =
      artifact.archive_download_url;

    /* -------------------------------- */
    /* IMPORTANT: Direct APK URL       */
    /* -------------------------------- */

    const publicBaseUrl =
      getPublicBaseUrl(req);

    job.apkUrl =
      `${publicBaseUrl}/api/build/${job.jobId}/apk`;

    return res.json({
      jobId: job.jobId,
      status: "success",
      stage: 6,
      stageName: "اكتمل",
      runId: job.runId,

      /* Direct APK URL for Android app */
      apkUrl: job.apkUrl,
      downloadUrl: job.apkUrl,

      /* Kept for debugging */
      artifactUrl: job.artifactUrl,

      apkAvailable: true,
      error: null
    });

  } catch (error) {
    console.error(
      "STATUS ERROR:",
      error
    );

    return res.status(500).json({
      error: "Failed to read build status",
      details: error.message
    });
  }
});

/* -------------------------------- */
/* DIRECT APK DOWNLOAD              */
/* -------------------------------- */

app.get("/api/build/:jobId/apk", async (req, res) => {
  let tempDir = null;

  try {
    const job = jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    if (!job.runId) {
      return res.status(400).json({
        error: "Build is not completed yet"
      });
    }

    if (!GITHUB_TOKEN || !GITHUB_OWNER) {
      return res.status(500).json({
        error: "GitHub configuration is missing"
      });
    }

    /* -------------------------------- */
    /* Find Artifact                   */
    /* -------------------------------- */

    const artifactsUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${job.runId}/artifacts`;

    const artifactsResponse =
      await fetch(artifactsUrl, {
        headers: githubHeaders()
      });

    if (!artifactsResponse.ok) {
      return res.status(502).json({
        error: "Unable to access GitHub artifacts"
      });
    }

    const artifactsData =
      await artifactsResponse.json();

    const artifact =
      (artifactsData.artifacts || [])
        .find(
          a =>
            a.name === "app-debug" &&
            !a.expired
        );

    if (!artifact) {
      return res.status(404).json({
        error: "APK artifact not found"
      });
    }

    /* -------------------------------- */
    /* Download Artifact ZIP            */
    /* -------------------------------- */

    const artifactResponse =
      await fetch(
        artifact.archive_download_url,
        {
          headers: {
            ...githubHeaders(),
            Accept:
              "application/vnd.github+json"
          },
          redirect: "follow"
        }
      );

    if (!artifactResponse.ok) {
      return res.status(502).json({
        error: "Failed to download APK artifact"
      });
    }

    const artifactBuffer =
      Buffer.from(
        await artifactResponse.arrayBuffer()
      );

    /* -------------------------------- */
    /* Temporary directory              */
    /* -------------------------------- */

    tempDir = await fs.promises.mkdtemp(
      path.join(
        os.tmpdir(),
        "zipapk-"
      )
    );

    const artifactZipPath =
      path.join(
        tempDir,
        "artifact.zip"
      );

    await fs.promises.writeFile(
      artifactZipPath,
      artifactBuffer
    );

    /* -------------------------------- */
    /* Extract APK                     */
    /* -------------------------------- */

    const directory =
      await unzipper.Open.file(
        artifactZipPath
      );

    const apkEntry =
      directory.files.find(
        file =>
          file.type === "File" &&
          file.path.toLowerCase().endsWith(".apk")
      );

    if (!apkEntry) {
      return res.status(404).json({
        error: "APK file was not found inside artifact"
      });
    }

    const safeAppName =
      String(job.appName || "app")
        .replace(
          /[^a-zA-Z0-9._-]/g,
          "_"
        );

    const apkFilename =
      `${safeAppName}.apk`;

    /* -------------------------------- */
    /* Send APK directly               */
    /* -------------------------------- */

    res.setHeader(
      "Content-Type",
      "application/vnd.android.package-archive"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${apkFilename}"`
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=3600"
    );

    const apkStream =
      apkEntry.stream();

    apkStream.on(
      "error",
      error => {
        console.error(
          "APK stream error:",
          error
        );

        if (!res.headersSent) {
          res.status(500).json({
            error: "APK streaming failed"
          });
        } else {
          res.destroy(error);
        }
      }
    );

    apkStream.pipe(res);

    apkStream.on(
      "end",
      async () => {
        if (tempDir) {
          try {
            await fs.promises.rm(
              tempDir,
              {
                recursive: true,
                force: true
              }
            );
          } catch {}
        }
      }
    );

  } catch (error) {
    console.error(
      "APK DOWNLOAD ERROR:",
      error
    );

    if (!res.headersSent) {
      return res.status(500).json({
        error: "Failed to prepare APK download",
        details: error.message
      });
    }

    res.destroy(error);

  }
});

/* -------------------------------- */
/* GitHub Run Information           */
/* -------------------------------- */

app.get(
  "/api/build/:jobId/run",
  async (req, res) => {
    try {
      const job =
        jobs.get(req.params.jobId);

      if (!job) {
        return res.status(404).json({
          error: "Job not found"
        });
      }

      if (!job.runId) {
        return res.json({
          runId: null
        });
      }

      const runUrl =
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${job.runId}`;

      const response =
        await fetch(runUrl, {
          headers: githubHeaders()
        });

      const data =
        await response.json();

      return res.json({
        runId: job.runId,
        status: data.status,
        conclusion: data.conclusion,
        htmlUrl: data.html_url
      });

    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

/* -------------------------------- */
/* Cancel Build                     */
/* -------------------------------- */

app.delete(
  "/api/build/:jobId",
  async (req, res) => {
    try {
      const job =
        jobs.get(req.params.jobId);

      if (!job) {
        return res.status(404).json({
          error: "Job not found"
        });
      }

      if (!job.runId) {
        job.status = "cancelled";

        return res.json({
          ok: true,
          status: "cancelled"
        });
      }

      const cancelUrl =
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${job.runId}/cancel`;

      const response =
        await fetch(cancelUrl, {
          method: "POST",
          headers: githubHeaders()
        });

      if (!response.ok) {
        return res.status(response.status).json({
          error: "Failed to cancel GitHub build"
        });
      }

      job.status = "cancelled";
      job.stageName = "ملغي";

      return res.json({
        ok: true,
        status: "cancelled"
      });

    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

/* -------------------------------- */
/* Helper                           */
/* -------------------------------- */

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

/* -------------------------------- */
/* Start Server                     */
/* -------------------------------- */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `ZIPAPK Build Server running on port ${PORT}`
    );
  }
);
