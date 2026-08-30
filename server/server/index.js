import express from "express";
import multer from "multer";
import fs from "fs";
import crypto from "crypto";

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

/* -------------------------------- */
/* Middleware                        */
/* -------------------------------- */

app.use(express.json());

/* -------------------------------- */
/* Health                            */
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
/* Start Build                       */
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

          const possibleRuns =
            (runsData.workflow_runs || [])
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
/* Get Build Status                  */
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
        apkAvailable: false,
        downloadUrl: null,
        artifactUrl: null,
        error: job.error
      });
    }

    /* -------------------------------- */
    /* Get GitHub Run                   */
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
        apkAvailable: false,
        downloadUrl: null,
        artifactUrl: job.artifactUrl,
        error: job.error
      });
    }

    const run = await runResponse.json();

    /* -------------------------------- */
    /* Still Building                   */
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
        apkAvailable: false,
        downloadUrl: null,
        artifactUrl: null,
        error: null
      });
    }

    /* -------------------------------- */
    /* Build Failed                     */
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
        apkAvailable: false,
        downloadUrl: null,
        artifactUrl: null,
        error: job.error
      });
    }

    /* -------------------------------- */
    /* Build Successful                 */
    /* -------------------------------- */

    job.status = "success";
    job.stage = 6;
    job.stageName = "اكتمل";

    /* -------------------------------- */
    /* Find APK Artifact                */
    /* -------------------------------- */

    const artifactsUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${job.runId}/artifacts`;

    const artifactsResponse =
      await fetch(artifactsUrl, {
        headers: githubHeaders()
      });

    if (artifactsResponse.ok) {
      const artifactsData =
        await artifactsResponse.json();

      const artifact =
        (artifactsData.artifacts || [])
          .find(
            a =>
              a.name === "app-debug" &&
              !a.expired
          );

      if (artifact) {
        job.artifactUrl =
          artifact.archive_download_url;

        /*
         * مهم جداً:
         * لا نرسل رابط GitHub مباشرة للتطبيق.
         * نرسل رابط السيرفر الخاص بنا.
         */
        job.apkUrl =
          `/api/build/${job.jobId}/download`;
      }
    }

    const downloadUrl = job.apkUrl
      ? `${getPublicBaseUrl(req)}${job.apkUrl}`
      : null;

    return res.json({
      jobId: job.jobId,
      status: "success",
      stage: 6,
      stageName: "اكتمل",
      runId: job.runId,

      /*
       * هذه الأسماء هي التي ينتظرها التطبيق.
       */
      apkAvailable: Boolean(job.artifactUrl),
      downloadUrl: downloadUrl,

      /*
       * نترك artifactUrl أيضاً للمعلومات الداخلية.
       */
      artifactUrl: job.artifactUrl,

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
/* Download APK                      */
/* -------------------------------- */

app.get("/api/build/:jobId/download", async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    if (!job.artifactUrl) {
      return res.status(404).json({
        error: "APK artifact is not available yet"
      });
    }

    if (!GITHUB_TOKEN) {
      return res.status(500).json({
        error: "GitHub token is not configured"
      });
    }

    /*
     * تحميل Artifact من GitHub باستخدام Token
     */
    const artifactResponse =
      await fetch(job.artifactUrl, {
        headers: {
          ...githubHeaders(),
          Accept:
            "application/vnd.github+json"
        },
        redirect: "manual"
      });

    /*
     * GitHub قد يرجع Redirect إلى رابط التحميل الحقيقي.
     */
    if (
      artifactResponse.status >= 300 &&
      artifactResponse.status < 400
    ) {
      const redirectUrl =
        artifactResponse.headers.get("location");

      if (!redirectUrl) {
        return res.status(502).json({
          error:
            "GitHub did not provide download location"
        });
      }

      const fileResponse =
        await fetch(redirectUrl);

      if (!fileResponse.ok) {
        return res.status(502).json({
          error:
            "Failed to download APK artifact from GitHub"
        });
      }

      res.setHeader(
        "Content-Type",
        "application/zip"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFileName(job.jobId)}.zip"`
      );

      if (fileResponse.body) {
        return fileResponse.body.pipeTo(
          new WritableStream({
            write(chunk) {
              res.write(Buffer.from(chunk));
            },
            close() {
              res.end();
            },
            abort(error) {
              console.error(
                "Download stream error:",
                error
              );
              res.end();
            }
          })
        );
      }
    }

    /*
     * بعض استجابات GitHub قد تعطي الملف مباشرة.
     */
    if (artifactResponse.ok) {
      res.setHeader(
        "Content-Type",
        artifactResponse.headers.get(
          "content-type"
        ) || "application/zip"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFileName(job.jobId)}.zip"`
      );

      if (artifactResponse.body) {
        return artifactResponse.body.pipeTo(
          new WritableStream({
            write(chunk) {
              res.write(Buffer.from(chunk));
            },
            close() {
              res.end();
            },
            abort(error) {
              console.error(
                "Download stream error:",
                error
              );
              res.end();
            }
          })
        );
      }
    }

    return res.status(502).json({
      error:
        "Unable to download APK artifact"
    });

  } catch (error) {
    console.error(
      "DOWNLOAD ERROR:",
      error
    );

    if (!res.headersSent) {
      return res.status(500).json({
        error: "APK download failed",
        details: error.message
      });
    }
  }
});

/* -------------------------------- */
/* Workflow Run Info                */
/* -------------------------------- */

app.get("/api/build/:jobId/run", async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);

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

    const response = await fetch(runUrl, {
      headers: githubHeaders()
    });

    const data = await response.json();

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
});

/* -------------------------------- */
/* Helpers                           */
/* -------------------------------- */

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function safeFileName(jobId) {
  return `app-${jobId}.zip`;
}

function getPublicBaseUrl(req) {
  /*
   * إذا كان السيرفر خلف Proxy مثل Render/Railway،
   * استخدم X-Forwarded-Proto مع host.
   */
  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "https";

  const host =
    req.headers["x-forwarded-host"] ||
    req.get("host");

  return `${protocol}://${host}`;
}

/* -------------------------------- */
/* Start Server                     */
/* -------------------------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `ZIPAPK Build Server running on port ${PORT}`
  );
});
