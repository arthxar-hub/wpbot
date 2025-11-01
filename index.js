const express = require("express");
const cookieParser = require("cookie-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const app = express();

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

const clients = {};
const jobs = {}; // Structure: jobs[sessionId][groupId] = { intervalId, groupName }

function genId() {
  return "s" + Math.random().toString(36).slice(2, 9);
}

function createClient(sessionId) {
  if (clients[sessionId]) return clients[sessionId].client;
  const sessionDir = path.join(__dirname, "sessions", sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: sessionDir,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    },
  });

  clients[sessionId] = { client, ready: false, qr: null };

  client.on("qr", async (qr) => {
    const dataUrl = await QRCode.toDataURL(qr);
    clients[sessionId].qr = dataUrl;
  });

  client.on("ready", async () => {
    clients[sessionId].ready = true;
    console.log([${sessionId}] ✅ Ready);
  });

  client.on("disconnected", (reason) => {
    console.log([${sessionId}] disconnected:, reason);
    // Stop all jobs for this session
    if (jobs[sessionId]) {
      Object.values(jobs[sessionId]).forEach(job => clearInterval(job.intervalId));
      delete jobs[sessionId];
    }
    delete clients[sessionId];
  });

  client.initialize();
  return client;
}

app.get("/", (req, res) => {
  const sid = req.cookies.session_id;
  if (sid) return res.redirect(/session/${sid});
  res.redirect("/create");
});

app.get("/create", (req, res) => {
  const old = req.cookies.session_id;
  if (old && clients[old]) return res.redirect(/session/${old});
  const sessionId = genId();
  createClient(sessionId);
  res.cookie("session_id", sessionId, { maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.redirect(/session/${sessionId});
});

app.get("/session/:sessionId", (req, res) => {
  const id = req.params.sessionId;
  if (!clients[id]) createClient(id);
  res.send(`
<html>
<head><title>Session ${id}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { background:#0b1220; color:#fff; font-family:sans-serif; padding:20px; }
.card { background:#101a2f; border-radius:10px; padding:20px; max-width:750px; margin:auto; box-shadow:0 0 10px #000; }
input, textarea, select { width:100%; margin:8px 0; padding:8px; border:none; border-radius:6px; background:#1e2a44; color:white; }
button { background:#2563eb; border:none; color:white; padding:10px 15px; border-radius:6px; cursor:pointer; margin-right:6px; }
button:hover { background:#1d4ed8; }
button.stop { background:#dc2626; }
button.stop:hover { background:#b91c1c; }
img { border-radius:8px; border:2px solid #22303f; margin-top:10px; }
#groupsList { margin-top:15px; background:#0d152b; padding:10px; border-radius:6px; }
.running-job { background:#1e3a1e; padding:8px; margin:6px 0; border-radius:6px; border-left:3px solid #22c55e; }
.job-header { display:flex; justify-content:space-between; align-items:center; }
</style>
</head>
<body>
<div class="card">
<h2>WhatsApp Session: ${id}</h2>
<div id="qr">Waiting for QR...</div>
<div id="status">Status: ⏳ Initializing...</div>
<div id="panel" style="display:none;">
<h3>Active Jobs</h3>
<div id="activeJobs">No active jobs</div>

<h3>Your Groups</h3>
<div id="groupsList">Loading groups...</div>

<h3>Spam / Rename Settings</h3>
<select id="groupSelect"></select>
<input id="delay" placeholder="Delay (ms)" value="5000" />
<textarea id="names" rows="2" placeholder="Enter new group names (comma separated)"></textarea>
<textarea id="descs" rows="2" placeholder="Enter new descriptions (comma separated)"></textarea>
<textarea id="msgs" rows="2" placeholder="Enter messages (comma separated)"></textarea>
<button onclick="start()">Start Job</button>
<button onclick="stopAll()" class="stop">Stop All Jobs</button>
<button onclick="logout()">Logout</button>
<pre id="log"></pre>
</div>
</div>
<script>
const sid = "${id}";
async function poll() {
  const res = await fetch("/status/" + sid);
  const j = await res.json();
  document.getElementById("status").innerText =
    j.ready ? "✅ Connected" : j.qr ? "📱 Scan QR shown below" : "⏳ Waiting...";
  if (j.qr) document.getElementById("qr").innerHTML = '<img src="'+j.qr+'" width="260">';
  if (j.ready) {
    document.getElementById("qr").innerHTML = '';
    document.getElementById("panel").style.display = "block";
    loadGroups();
    loadActiveJobs();
    setInterval(loadActiveJobs, 2000);
  } else setTimeout(poll, 3000);
}
poll();

async function loadGroups() {
  const res = await fetch("/groups/" + sid);
  const data = await res.json();
  const list = document.getElementById("groupsList");
  const sel = document.getElementById("groupSelect");
  sel.innerHTML = "";
  if (data.length === 0) list.innerText = "No groups found.";
  else {
    list.innerHTML = data.map(g => "• " + g.name + " <small style='color:#888'>(" + g.id + ")</small>").join("<br>");
    data.forEach(g => {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.innerText = g.name;
      sel.appendChild(opt);
    });
  }
}

async function loadActiveJobs() {
  const res = await fetch("/active-jobs/" + sid);
  const data = await res.json();
  const container = document.getElementById("activeJobs");
  
  if (data.length === 0) {
    container.innerHTML = "<div style='color:#888;'>No active jobs</div>";
  } else {
    container.innerHTML = data.map(job => 
      \`<div class="running-job">
        <div class="job-header">
          <span>🟢 \${job.groupName}</span>
          <button class="stop" onclick="stopJob('\${job.groupId}')">Stop</button>
        </div>
        <small style="color:#888;">ID: \${job.groupId}</small>
      </div>\`
    ).join("");
  }
}

async function start() {
  const group = document.getElementById("groupSelect").value;
  const delay = document.getElementById("delay").value;
  const names = document.getElementById("names").value;
  const descs = document.getElementById("descs").value;
  const msgs = document.getElementById("msgs").value;
  
  if (!group) {
    append("❌ Please select a group");
    return;
  }
  
  const res = await fetch("/start/" + sid, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group, delay, names, descs, msgs })
  });
  const result = await res.json();
  append(result.error || "✅ Job started for group");
  loadActiveJobs();
}

async function stopJob(groupId) {
  const res = await fetch("/stop/" + sid, { 
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: groupId })
  });
  const result = await res.json();
  append(result.msg || "✅ Job stopped");
  loadActiveJobs();
}

async function stopAll() {
  const res = await fetch("/stop-all/" + sid, { method: "POST" });
  const result = await res.json();
  append(result.msg || "✅ All jobs stopped");
  loadActiveJobs();
}

async function logout() {
  const res = await fetch("/logout/" + sid, { method: "POST" });
  append(JSON.stringify(await res.json()));
  if (res.ok) location.reload();
}

function append(t) {
  const p = document.getElementById("log");
  p.innerText = new Date().toLocaleTimeString() + " | " + t + "\\n" + p.innerText;
}
</script>
</body></html>`);
});

app.get("/status/:sessionId", (req, res) => {
  const id = req.params.sessionId;
  const c = clients[id];
  if (!c) return res.json({ ready: false, qr: null });
  res.json({ ready: c.ready, qr: c.qr });
});

app.get("/groups/:sessionId", async (req, res) => {
  const id = req.params.sessionId;
  const record = clients[id];
  if (!record || !record.ready) return res.json([]);
  try {
    const chats = await record.client.getChats();
    const groups = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));
    res.json(groups);
  } catch {
    res.json([]);
  }
});

app.get("/active-jobs/:sessionId", (req, res) => {
  const id = req.params.sessionId;
  if (!jobs[id]) return res.json([]);
  
  const activeJobs = Object.entries(jobs[id]).map(([groupId, job]) => ({
    groupId,
    groupName: job.groupName
  }));
  
  res.json(activeJobs);
});

app.post("/start/:sessionId", async (req, res) => {
  const { group, names, descs, msgs, delay } = req.body;
  const id = req.params.sessionId;
  const record = clients[id];
  
  if (!record || !record.ready) return res.status(400).json({ error: "Client not ready" });
  
  // Initialize jobs object for this session if it doesn't exist
  if (!jobs[id]) jobs[id] = {};
  
  // Check if job already running for this group
  if (jobs[id][group]) {
    return res.status(400).json({ error: "Job already running for this group. Stop it first." });
  }
  
  const client = record.client;
  
  try {
    const groupChat = await client.getChatById(group);
    if (!groupChat) return res.status(404).json({ error: "Group not found" });
    
    const nameArr = names.split(",").map(x => x.trim()).filter(Boolean);
    const descArr = descs.split(",").map(x => x.trim()).filter(Boolean);
    const msgArr = msgs.split(",").map(x => x.trim()).filter(Boolean);
    
    let i = 0;
    const intervalId = setInterval(async () => {
      try {
        const newName = nameArr[i % nameArr.length] || "Unnamed Group";
        const newDesc = descArr[i % descArr.length] || "No description";
        const newMsg = msgArr[i % msgArr.length] || "Hello from bot!";
        
        await groupChat.setSubject(newName);
        await groupChat.setDescription(newDesc);
        await groupChat.sendMessage(newMsg);
        
        console.log([${id}] Updated group ${group}: ${newName});
        i++;
      } catch (e) {
        console.error([${id}] Update error for group ${group}:, e.message);
      }
    }, Math.max(3000, parseInt(delay) || 5000));
    
    jobs[id][group] = { 
      intervalId, 
      groupName: groupChat.name 
    };
    
    res.json({ ok: true, started: true, groupId: group });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/stop/:sessionId", (req, res) => {
  const id = req.params.sessionId;
  const { group } = req.body;
  
  if (!jobs[id] || !jobs[id][group]) {
    return res.json({ ok: false, msg: "No active job found for this group" });
  }
  
  clearInterval(jobs[id][group].intervalId);
  delete jobs[id][group];
  
  // Clean up session jobs object if empty
  if (Object.keys(jobs[id]).length === 0) {
    delete jobs[id];
  }
  
  res.json({ ok: true, stopped: true, msg: "Job stopped successfully" });
});

app.post("/stop-all/:sessionId", (req, res) => {
  const id = req.params.sessionId;
  
  if (!jobs[id]) {
    return res.json({ ok: true, msg: "No active jobs to stop" });
  }
  
  Object.values(jobs[id]).forEach(job => clearInterval(job.intervalId));
  delete jobs[id];
  
  res.json({ ok: true, msg: "All jobs stopped successfully" });
});

app.post("/logout/:sessionId", async (req, res) => {
  const id = req.params.sessionId;
  if (!clients[id]) return res.json({ ok: false });
  
  // Stop all jobs before logout
  if (jobs[id]) {
    Object.values(jobs[id]).forEach(job => clearInterval(job.intervalId));
    delete jobs[id];
  }
  
  try {
    await clients[id].client.logout();
  } catch {}
  
  delete clients[id];
  res.json({ ok: true, msg: "Session logged out" });
});

app.listen(3000, "0.0.0.0", () => console.log("🔥 Server running on http://localhost:3000"));
