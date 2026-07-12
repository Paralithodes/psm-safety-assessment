/**
 * PSM 안전수준 평가 - 화면 로직
 * 문제은행 데이터는 questions.js 의 QUESTION_BANK 를 사용합니다.
 *
 * 일반 사용자는 두 가지만 이용합니다.
 *  - exam  : "PSM 수준평가" - 12대 요소에서 골고루 뽑은 25문항에 답을 체크/기입하고,
 *            평가 종료 후 한꺼번에 채점하는 정식 시험
 *  - study : "요소별 학습" - 12대 요소별로 정리된 핵심 내용을 학습하는 모드 (문항이 아님)
 *
 * "체크리스트 평가"와 응시자 결과/분석은 관리자 전용이며 비밀번호로 보호됩니다.
 */

const ADMIN_PASSWORD = "sheq1357";

// ---- 체크리스트 모드 점수 척도 (관리자 전용) ----
const SCORE_SCALE = [
  { value: 3, label: "우수", color: "#2e7d32" },
  { value: 2, label: "양호", color: "#1e88e5" },
  { value: 1, label: "보통", color: "#fb8c00" },
  { value: 0, label: "미흡", color: "#e53935" }
];
const MAX_SCORE = Math.max(...SCORE_SCALE.map(s => s.value));
const NA_VALUE = "na";

const GRADE_TABLE = [
  { min: 90, grade: "A", label: "우수", color: "#2e7d32" },
  { min: 75, grade: "B", label: "양호", color: "#1e88e5" },
  { min: 60, grade: "C", label: "보통(개선 필요)", color: "#fb8c00" },
  { min: 0, grade: "D", label: "미흡(시급 개선)", color: "#e53935" }
];

const EXAM_TOTAL_QUESTIONS = 25;
const STORAGE_KEY = "psm_assessment_v5";
const COMPANY_NAME = "씨지앤대산전력";

// 응시 결과를 자동으로 전송할 구글시트(Apps Script 웹앱) 주소.
// 이 주소는 "쓰기 전용 우체통"이라 결과를 받기만 하고, 결과를 읽는 것은
// 이 주소를 만든 구글시트 소유자만 가능합니다(시트가 비공개이기 때문).
const RESULTS_ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbzE32Dpz74iHOgp3zZxgBLw7zLptOO7VDaQLmVVQeNjHmjNqv3lcU7YtJLiySXN-n0/exec";

function sendResultToCloud(entry) {
  if (!RESULTS_ENDPOINT_URL || RESULTS_ENDPOINT_URL.indexOf("http") !== 0) return;
  fetch(RESULTS_ENDPOINT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(entry)
  }).catch(() => {
    // 네트워크 오류 등으로 실패해도 로컬 저장(localStorage)에는 이미 남아있으므로
    // 조용히 무시합니다. (JSON 내보내기로 수동 전달하는 방법은 계속 사용 가능)
  });
}

const MODE_LABEL = {
  exam: { name: "PSM 수준평가", icon: "📝" },
  study: { name: "요소별 학습", icon: "📚" }
};

// ---- 전역 문항 색인 ----
const QUESTION_INDEX = {}; // qId -> { cat, q }
QUESTION_BANK.categories.forEach(cat => {
  cat.questions.forEach(q => { QUESTION_INDEX[q.id] = { cat, q }; });
});

// ---- 화면 영역 상태 (세션 한정, 저장 안 함) ----
let appArea = "user";      // "user" | "admin"
let adminAuthed = false;
let adminView = "results"; // "checklist" | "results" | "analysis"
let checklistView = QUESTION_BANK.categories[0].id; // categoryId 또는 "result" (관리자 체크리스트용)
let studyView = QUESTION_BANK.categories[0].id;     // categoryId (요소별 학습용)

// ---- 영구 저장 상태 ----
let state = {
  meta: { date: new Date().toISOString().slice(0, 10) },
  subject: { department: "", position: "", name: "" },
  mode: "exam",
  checklist: {}, // { [catId]: { [qId]: { score: number|"na"|null, note: string } } }
  study: {},     // { [catId]: { done: bool } }
  exam: {
    phase: "intake",   // "intake" | "taking" | "submitted"
    id: null,
    questionIds: null,
    answers: {},        // { [qId]: { selected: number|null, text: string } }
    manualGrades: {},   // { [qId]: true|false }
    startedAt: null,
    submittedAt: null
  },
  examLog: [] // 관리자 화면에서 보는 응시자 결과 기록
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        ...state, ...parsed,
        meta: { ...state.meta, ...(parsed.meta || {}) },
        subject: { ...state.subject, ...(parsed.subject || {}) },
        exam: { ...state.exam, ...(parsed.exam || {}) },
        examLog: parsed.examLog || []
      };
    }
  } catch (e) {
    console.warn("저장된 데이터를 불러오지 못했습니다.", e);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(n) { return Math.round(n * 10) / 10; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function formatDT(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function gradeOf(pct) {
  if (pct === null || pct === undefined) return { grade: "-", label: "평가 미완료", color: "#9e9e9e" };
  return GRADE_TABLE.find(g => pct >= g.min);
}

function nextMin(g) {
  const idx = GRADE_TABLE.indexOf(g);
  return idx > 0 ? GRADE_TABLE[idx - 1].min - 0.1 + "% 미만" : "";
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- 객관식(1~N 보기) 문제 파싱 ----
// 보기 표기 형식이 "1) ... 2) ..." (한 줄에 나열) 이거나
// "①...\n②...\n③..." (원문자, 줄바꿈으로 구분) 인 경우를 모두 인식한다.
const CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩";

function parseMCQ(text) {
  const src = text || "";
  const markerRe = /(\d{1,2})\)|([①②③④⑤⑥⑦⑧⑨⑩])/g;
  const candidates = [];
  let m;
  while ((m = markerRe.exec(src))) {
    const num = m[1] ? parseInt(m[1], 10) : CIRCLED_DIGITS.indexOf(m[2]) + 1;
    candidates.push({ index: m.index, length: m[0].length, num });
  }

  let seq = null;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].num !== 1) continue;
    const cand = [candidates[i]];
    let expect = 2;
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[j].num === expect) { cand.push(candidates[j]); expect++; }
    }
    if (cand.length >= 2) { seq = cand; break; }
  }
  if (!seq) return null;

  const stem = src.slice(0, seq[0].index).trim();
  if (!stem) return null;

  const options = seq.map((c, idx) => {
    const endIdx = idx + 1 < seq.length ? seq[idx + 1].index : src.length;
    const label = src.slice(c.index, endIdx).trim();
    const optText = src.slice(c.index + c.length, endIdx).trim();
    return { num: c.num, label, text: optText };
  });

  return { stem, options };
}

function parseCorrectNum(answer) {
  const a = (answer || "").trim();
  const circledIdx = CIRCLED_DIGITS.indexOf(a[0]);
  if (circledIdx >= 0) return circledIdx + 1;
  const m = a.match(/^(\d{1,2})\)/);
  return m ? parseInt(m[1], 10) : null;
}

// ---- 요소별 학습 콘텐츠 (문항이 아니라 해설을 정리한 핵심 포인트) ----
function buildStudyPoints(cat) {
  const seen = new Set();
  const points = [];
  cat.questions.forEach(q => {
    const g = (q.guide || "").trim();
    if (g && !seen.has(g)) { seen.add(g); points.push(g); }
  });
  return points;
}

// ================= 공통 DOM 참조 =================
const sidebarEl = document.getElementById("sidebar");
const mainEl = document.getElementById("main");
const progressBarWrapEl = document.getElementById("progress-bar-wrap");
const progressFillEl = document.getElementById("progress-fill");
const progressTextEl = document.getElementById("progress-text");
const modeBarEl = document.getElementById("mode-bar");

// ================= 상단 모드 바 =================
function renderModeBar() {
  if (appArea === "admin") {
    modeBarEl.innerHTML = `
      <span class="mode-label">관리자</span>
      <div class="mode-toggle">
        <button class="mode-btn ${adminView === "checklist" ? "active" : ""}" data-admin="checklist">📋 체크리스트 평가</button>
        <button class="mode-btn ${adminView === "results" ? "active" : ""}" data-admin="results">🧑‍💼 응시자 결과</button>
        <button class="mode-btn ${adminView === "analysis" ? "active" : ""}" data-admin="analysis">📊 분석</button>
      </div>
      <button class="btn-outline admin-exit" id="btn-admin-exit">← 일반 화면으로</button>
    `;
    modeBarEl.querySelectorAll("[data-admin]").forEach(btn => {
      btn.addEventListener("click", () => { adminView = btn.dataset.admin; render(); });
    });
    document.getElementById("btn-admin-exit").addEventListener("click", () => { appArea = "user"; render(); });
    return;
  }

  modeBarEl.innerHTML = `
    <span class="mode-label">평가 모드</span>
    <div class="mode-toggle">
      ${Object.keys(MODE_LABEL).map(key => `
        <button class="mode-btn ${state.mode === key ? "active" : ""}" data-mode="${key}">
          ${MODE_LABEL[key].icon} ${MODE_LABEL[key].name}
        </button>`).join("")}
    </div>
  `;
  modeBarEl.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (state.mode === btn.dataset.mode) return;
      state.mode = btn.dataset.mode;
      saveState();
      render();
    });
  });
}

// ================= 진행률 바 =================
function renderProgressBar() {
  if (appArea === "admin") {
    progressBarWrapEl.style.display = "none";
    return;
  }
  progressBarWrapEl.style.display = "flex";

  if (state.mode === "exam") {
    if (state.exam.phase === "intake") {
      progressFillEl.style.width = "0%";
      progressTextEl.textContent = "[PSM 수준평가] 응시자 정보를 입력하고 평가를 시작하세요";
      return;
    }
    const total = (state.exam.questionIds || []).length;
    const answered = (state.exam.questionIds || []).filter(qId => isExamAnswered(qId)).length;
    const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
    progressFillEl.style.width = pct + "%";
    progressTextEl.textContent = state.exam.phase === "submitted"
      ? `[PSM 수준평가] 채점 완료 (${total}문항)`
      : `[PSM 수준평가] ${answered} / ${total} 문항 응답 (${pct}%)`;
    return;
  }

  // study
  const total = QUESTION_BANK.categories.length;
  const done = QUESTION_BANK.categories.filter(c => (state.study[c.id] || {}).done).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFillEl.style.width = pct + "%";
  progressTextEl.textContent = `[요소별 학습] ${done} / ${total} 요소 학습 완료 (${pct}%)`;
}

// ================= 사이드바 =================
function renderSidebar() {
  if (appArea === "admin") {
    if (adminView === "checklist") { renderChecklistSidebar(); return; }
    sidebarEl.innerHTML = "";
    return;
  }
  if (state.mode === "exam") {
    if (state.exam.phase === "intake") {
      sidebarEl.innerHTML = `
        <div class="exam-side-panel">
          <div class="exam-side-title">📝 PSM 수준평가</div>
          <p class="exam-side-desc">12대 요소에서 골고루 뽑은 ${EXAM_TOTAL_QUESTIONS}문항으로 진행됩니다. 오른쪽에 정보를 입력하고 평가를 시작하세요.</p>
        </div>`;
      return;
    }
    renderExamSidebar();
    return;
  }
  renderStudySidebar();
}

function renderChecklistSidebar() {
  let html = "";
  QUESTION_BANK.categories.forEach(cat => {
    const r = computeChecklistScore(cat);
    const done = r.answeredOfApplicable === r.applicable && r.applicable > 0;
    const active = checklistView === cat.id ? "active" : "";
    const pctLabel = r.pct === null ? "-" : r.pct + "%";
    html += `
      <button class="nav-item ${active}" data-cat="${cat.id}">
        <span class="nav-item-name">${cat.name}</span>
        <span class="nav-item-meta">
          <span class="nav-item-pct">${pctLabel}</span>
          <span class="nav-dot ${done ? "done" : ""}"></span>
        </span>
      </button>`;
  });
  html += `
    <div class="nav-divider"></div>
    <button class="nav-item result-btn ${checklistView === "result" ? "active" : ""}" data-cat="result">
      <span class="nav-item-name">📊 종합 결과</span>
    </button>`;
  sidebarEl.innerHTML = html;
  sidebarEl.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => { checklistView = btn.dataset.cat; render(); });
  });
}

function renderStudySidebar() {
  let html = "";
  QUESTION_BANK.categories.forEach(cat => {
    const points = buildStudyPoints(cat);
    const done = (state.study[cat.id] || {}).done;
    const active = studyView === cat.id ? "active" : "";
    html += `
      <button class="nav-item ${active}" data-cat="${cat.id}">
        <span class="nav-item-name">${cat.name}</span>
        <span class="nav-item-meta">
          <span class="nav-item-pct">${points.length}개</span>
          <span class="nav-dot ${done ? "done" : ""}"></span>
        </span>
      </button>`;
  });
  sidebarEl.innerHTML = html;
  sidebarEl.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => { studyView = btn.dataset.cat; render(); });
  });
}

function renderExamSidebar() {
  const total = (state.exam.questionIds || []).length;
  const answered = (state.exam.questionIds || []).filter(qId => isExamAnswered(qId)).length;
  sidebarEl.innerHTML = `
    <div class="exam-side-panel">
      <div class="exam-side-title">PSM 수준평가</div>
      <p class="exam-side-desc">12대 요소에서 골고루 뽑은 ${EXAM_TOTAL_QUESTIONS}문항입니다.</p>
      <div class="exam-side-stat">${state.exam.phase === "submitted" ? "채점 완료" : `${answered} / ${total} 문항 응답`}</div>
      <button class="btn-outline" id="btn-new-exam">🔀 새 평가 시작</button>
    </div>
  `;
  document.getElementById("btn-new-exam").addEventListener("click", () => {
    if (!confirm("현재 진행 중이거나 완료된 평가를 마치고, 새 응시자 정보 입력화면으로 돌아갑니다. 계속하시겠습니까?")) return;
    resetToIntake();
    render();
  });
}

function bindNavButtons(setView) {
  mainEl.querySelectorAll("[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => { setView(btn.dataset.nav); render(); });
  });
}

// ================= 체크리스트 평가 (관리자 전용) =================
function getChecklistAnswer(catId, qId) {
  return (state.checklist[catId] && state.checklist[catId][qId]) || { score: null, note: "" };
}

function setChecklistAnswer(catId, qId, patch) {
  if (!state.checklist[catId]) state.checklist[catId] = {};
  const prev = getChecklistAnswer(catId, qId);
  state.checklist[catId][qId] = { ...prev, ...patch };
  saveState();
}

function computeChecklistScore(cat) {
  let scored = 0;
  cat.questions.forEach(q => {
    const a = getChecklistAnswer(cat.id, q.id);
    if (typeof a.score === "number") scored += a.score;
  });
  const applicable = cat.questions.filter(q => getChecklistAnswer(cat.id, q.id).score !== "na").length;
  const answeredOfApplicable = cat.questions.filter(q => typeof getChecklistAnswer(cat.id, q.id).score === "number").length;
  const pct = applicable > 0 && answeredOfApplicable > 0
    ? Math.round((scored / (applicable * MAX_SCORE)) * 1000) / 10
    : null;
  return { scored, applicable, answeredOfApplicable, totalQuestions: cat.questions.length, pct };
}

function computeChecklistOverall() {
  const results = QUESTION_BANK.categories.map(cat => ({ cat, r: computeChecklistScore(cat) }));
  const withScore = results.filter(x => x.r.pct !== null);
  const overallPct = withScore.length > 0
    ? Math.round((withScore.reduce((s, x) => s + x.r.pct, 0) / withScore.length) * 10) / 10
    : null;
  const totalQ = QUESTION_BANK.categories.reduce((s, c) => s + c.questions.length, 0);
  const answeredQ = results.reduce((s, x) => s + x.r.answeredOfApplicable, 0);
  return { results, overallPct, totalQ, answeredQ };
}

function checklistQuestionCard(cat, q) {
  const a = getChecklistAnswer(cat.id, q.id);
  const scaleButtons = SCORE_SCALE.map(s => {
    const checked = a.score === s.value ? "checked" : "";
    return `
      <label class="score-opt score-${s.value}">
        <input type="radio" name="${q.id}" value="${s.value}" ${checked} />
        <span style="--score-color:${s.color}">${s.label}</span>
      </label>`;
  }).join("");
  const naChecked = a.score === NA_VALUE ? "checked" : "";

  return `
    <div class="q-card" data-qid="${q.id}">
      <div class="q-text">${escapeHtml(q.text)}</div>
      ${q.guide ? `<div class="q-guide">${escapeHtml(q.guide)}</div>` : ""}
      <div class="q-scale">
        ${scaleButtons}
        <label class="score-opt score-na">
          <input type="radio" name="${q.id}" value="na" ${naChecked} />
          <span>해당없음</span>
        </label>
      </div>
      <textarea class="q-note" placeholder="비고 / 근거 메모 (선택)">${a.note || ""}</textarea>
    </div>`;
}

function prevNextButtons(catId) {
  const ids = QUESTION_BANK.categories.map(c => c.id);
  const idx = ids.indexOf(catId);
  const prev = idx > 0 ? ids[idx - 1] : null;
  const next = idx < ids.length - 1 ? ids[idx + 1] : "result";
  return `
    ${prev ? `<button class="btn-outline" data-nav="${prev}">← 이전 요소</button>` : "<span></span>"}
    <button class="btn-primary" data-nav="${next}">${next === "result" ? "종합 결과 보기 →" : "다음 요소 →"}</button>
  `;
}

function renderChecklistCategory(cat) {
  const r = computeChecklistScore(cat);
  const pctLabel = r.pct === null ? "-" : r.pct + "%";

  mainEl.innerHTML = `
    <div class="admin-meta-row">
      <label>평가일 <input type="date" id="admin-meta-date" value="${state.meta.date}" /></label>
    </div>
    <div class="cat-header">
      <h2>${cat.name}</h2>
      <p class="cat-desc">${cat.description || ""}</p>
      <div class="cat-score-badge">현재 점수: <strong>${pctLabel}</strong> (${r.answeredOfApplicable}/${r.applicable} 응답)</div>
    </div>
    <div class="q-list">
      ${cat.questions.map(q => checklistQuestionCard(cat, q)).join("")}
    </div>
    <div class="cat-nav">
      ${prevNextButtons(cat.id)}
    </div>
  `;

  bindAdminMetaInputs();

  mainEl.querySelectorAll(".q-card").forEach(card => {
    const qid = card.dataset.qid;
    card.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener("change", () => {
        const val = input.value === "na" ? "na" : Number(input.value);
        setChecklistAnswer(cat.id, qid, { score: val });
        renderSidebar();
        renderChecklistCategory(cat);
      });
    });
    const noteEl = card.querySelector(".q-note");
    noteEl.addEventListener("input", () => {
      setChecklistAnswer(cat.id, qid, { note: noteEl.value });
    });
  });

  bindNavButtons(v => { checklistView = v; });
}

function bindAdminMetaInputs() {
  const date = document.getElementById("admin-meta-date");
  if (date) date.addEventListener("input", e => { state.meta.date = e.target.value; saveState(); });
}

function renderChecklistResult() {
  const overall = computeChecklistOverall();
  const og = gradeOf(overall.overallPct);

  const rows = overall.results.map(({ cat, r }) => {
    const g = gradeOf(r.pct);
    return `
      <tr>
        <td>${cat.name}</td>
        <td>${r.answeredOfApplicable}/${r.applicable}</td>
        <td>${r.pct === null ? "-" : r.pct + "%"}</td>
        <td><span class="grade-pill" style="background:${g.color}">${g.grade}</span> ${g.label}</td>
      </tr>`;
  }).join("");

  mainEl.innerHTML = `
    <div class="admin-meta-row">
      <label>평가일 <input type="date" id="admin-meta-date" value="${state.meta.date}" /></label>
    </div>
    <div class="cat-header">
      <h2>종합 평가 결과</h2>
      <p class="cat-desc">PSM 12대 요소별 이행 수준을 종합한 결과입니다.</p>
    </div>

    <div class="result-summary">
      <div class="result-overall" style="border-color:${og.color}">
        <div class="result-overall-label">종합 안전수준</div>
        <div class="result-overall-pct" style="color:${og.color}">${overall.overallPct === null ? "-" : overall.overallPct + "%"}</div>
        <div class="grade-pill big" style="background:${og.color}">${og.grade}등급 · ${og.label}</div>
      </div>
      <div class="result-radar">
        <canvas id="radar" width="360" height="360"></canvas>
      </div>
    </div>

    <table class="result-table">
      <thead><tr><th>PSM 요소</th><th>응답</th><th>점수</th><th>등급</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="result-actions">
      <button class="btn-outline" id="btn-export">JSON 내보내기</button>
      <button class="btn-outline" id="btn-print">인쇄 / PDF 저장</button>
      <button class="btn-danger" id="btn-reset">체크리스트 응답 초기화</button>
    </div>
    <p class="grade-legend">
      ${GRADE_TABLE.map(g => {
        const upper = nextMin(g);
        return `<span><span class="dot" style="background:${g.color}"></span>${g.grade} ${g.label} (${g.min}%${upper ? ` ~ ${upper}` : " 이상"})</span>`;
      }).join(" ")}
    </p>
  `;

  bindAdminMetaInputs();
  drawRadar(overall.results.map(x => ({ label: x.cat.name, pct: x.r.pct })));

  document.getElementById("btn-export").addEventListener("click", exportChecklistJson);
  document.getElementById("btn-print").addEventListener("click", () => window.print());
  document.getElementById("btn-reset").addEventListener("click", () => {
    if (!confirm("체크리스트 평가의 모든 응답을 초기화합니다. 계속하시겠습니까?")) return;
    state.checklist = {};
    saveState();
    checklistView = QUESTION_BANK.categories[0].id;
    render();
  });
}

function exportChecklistJson() {
  const overall = computeChecklistOverall();
  const payload = {
    mode: "checklist",
    meta: state.meta,
    generatedAt: new Date().toISOString(),
    overallPct: overall.overallPct,
    grade: gradeOf(overall.overallPct),
    categories: overall.results.map(({ cat, r }) => ({
      id: cat.id, name: cat.name, pct: r.pct, grade: gradeOf(r.pct).grade,
      answers: cat.questions.map(q => ({ id: q.id, text: q.text, ...getChecklistAnswer(cat.id, q.id) }))
    }))
  };
  downloadJson(payload, `PSM_체크리스트평가_${COMPANY_NAME}_${state.meta.date}.json`);
}

// ================= 요소별 학습 (일반 사용자) =================
function studyPrevNextButtons(catId) {
  const ids = QUESTION_BANK.categories.map(c => c.id);
  const idx = ids.indexOf(catId);
  const prev = idx > 0 ? ids[idx - 1] : null;
  const next = idx < ids.length - 1 ? ids[idx + 1] : null;
  return `
    ${prev ? `<button class="btn-outline" data-nav="${prev}">← 이전 요소</button>` : "<span></span>"}
    ${next ? `<button class="btn-primary" data-nav="${next}">다음 요소 →</button>` : "<span></span>"}
  `;
}

function renderStudyContent(cat) {
  const points = buildStudyPoints(cat);
  const done = (state.study[cat.id] || {}).done;

  mainEl.innerHTML = `
    <div class="cat-header">
      <h2>${cat.name}</h2>
      <p class="cat-desc">${cat.description || ""}</p>
    </div>

    <div class="study-content-card">
      <h3 class="study-content-title">핵심 정리</h3>
      ${points.length > 0
        ? `<ul class="study-content-list">${points.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
        : `<p class="cat-desc">등록된 학습 내용이 없습니다.</p>`}
    </div>

    <label class="study-done-toggle">
      <input type="checkbox" id="study-done-check" ${done ? "checked" : ""} />
      <span>이 요소 학습을 완료했습니다</span>
    </label>

    <div class="cat-nav">
      ${studyPrevNextButtons(cat.id)}
    </div>
  `;

  document.getElementById("study-done-check").addEventListener("change", e => {
    if (!state.study[cat.id]) state.study[cat.id] = {};
    state.study[cat.id].done = e.target.checked;
    saveState();
    renderSidebar();
    renderProgressBar();
  });

  bindNavButtons(v => { studyView = v; });
}

// ================= PSM 수준평가 (exam, 일반 사용자) =================
function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sampleN(arr, n) {
  const copy = arr.slice();
  const result = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

function resetToIntake() {
  state.exam = {
    phase: "intake", id: null, questionIds: null,
    answers: {}, manualGrades: {}, startedAt: null, submittedAt: null
  };
  state.subject = { department: "", position: "", name: "" };
  saveState();
}

function startNewExam() {
  const cats = QUESTION_BANK.categories;
  const k = cats.length;
  const base = Math.floor(EXAM_TOTAL_QUESTIONS / k);
  const remainder = EXAM_TOTAL_QUESTIONS - base * k;
  const order = shuffleArr(cats.map((c, i) => i));
  const counts = new Array(k).fill(base);
  for (let i = 0; i < remainder; i++) counts[order[i]] += 1;

  const questionIds = [];
  cats.forEach((cat, i) => {
    const n = Math.min(counts[i], cat.questions.length);
    sampleN(cat.questions, n).forEach(q => questionIds.push(q.id));
  });

  state.exam = {
    phase: "taking",
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    questionIds,
    answers: {},
    manualGrades: {},
    startedAt: new Date().toISOString(),
    submittedAt: null
  };
  saveState();
}

function getExamAnswer(qId) {
  return state.exam.answers[qId] || { selected: null, text: "" };
}

function setExamAnswer(qId, patch) {
  const prev = getExamAnswer(qId);
  state.exam.answers[qId] = { ...prev, ...patch };
  saveState();
}

function isExamAnswered(qId) {
  const { q } = QUESTION_INDEX[qId];
  const mcq = parseMCQ(q.text);
  const a = getExamAnswer(qId);
  return mcq ? a.selected !== null && a.selected !== undefined : !!(a.text && a.text.trim());
}

function renderExamMode() {
  if (state.exam.phase === "submitted") { renderExamReview(); return; }
  if (state.exam.phase === "taking" && state.exam.questionIds) { renderExamTaking(); return; }
  renderExamIntake();
}

function renderExamIntake() {
  mainEl.innerHTML = `
    <div class="intake-card">
      <h2>📝 PSM 수준평가</h2>
      <p class="cat-desc">시작하기 전에 아래 정보를 입력해 주세요. 12대 요소에서 골고루 뽑은 ${EXAM_TOTAL_QUESTIONS}문항이 출제되며, 채점은 평가를 마친 뒤 한 번에 진행됩니다.</p>
      <div class="intake-form">
        <label>평가일
          <input type="date" id="intake-date" value="${state.meta.date}" />
        </label>
        <label>부서
          <input type="text" id="intake-department" placeholder="예: SHEQ팀" value="${escapeAttr(state.subject.department)}" />
        </label>
        <label>직급
          <input type="text" id="intake-position" placeholder="예: 선임" value="${escapeAttr(state.subject.position)}" />
        </label>
        <label>이름
          <input type="text" id="intake-name" placeholder="예: 이상혁" value="${escapeAttr(state.subject.name)}" />
        </label>
      </div>
      <button class="btn-primary btn-submit" id="btn-start-exam">평가 시작하기</button>
    </div>
  `;

  const bind = (id, obj, key) => {
    document.getElementById(id).addEventListener("input", e => { obj[key] = e.target.value; saveState(); });
  };
  bind("intake-date", state.meta, "date");
  bind("intake-department", state.subject, "department");
  bind("intake-position", state.subject, "position");
  bind("intake-name", state.subject, "name");

  document.getElementById("btn-start-exam").addEventListener("click", () => {
    if (!state.subject.name || !state.subject.name.trim()) {
      alert("이름을 입력해주세요.");
      return;
    }
    startNewExam();
    render();
  });
}

function examQuestionMeta(qId) {
  const { cat } = QUESTION_INDEX[qId];
  return `<span class="exam-q-cat">${cat.name}</span>`;
}

function renderExamTaking() {
  const ids = state.exam.questionIds;
  const answeredCount = ids.filter(isExamAnswered).length;
  const subj = [state.subject.department, state.subject.position, state.subject.name].filter(Boolean).join(" / ");

  const items = ids.map((qId, i) => {
    const { q } = QUESTION_INDEX[qId];
    const mcq = parseMCQ(q.text);
    const a = getExamAnswer(qId);

    let inputBlock = "";
    if (mcq) {
      inputBlock = `
        <div class="exam-options">
          ${mcq.options.map(opt => `
            <label class="exam-option ${a.selected === opt.num ? "selected" : ""}">
              <input type="radio" name="exam-${qId}" value="${opt.num}" ${a.selected === opt.num ? "checked" : ""} />
              <span>${escapeHtml(opt.label)}</span>
            </label>
          `).join("")}
        </div>
      `;
    } else {
      inputBlock = `<textarea class="exam-text-answer" placeholder="답을 입력하세요">${escapeHtml(a.text)}</textarea>`;
    }

    return `
      <div class="exam-q-card" data-qid="${qId}">
        <div class="exam-q-head">
          <span class="exam-q-no">문항 ${i + 1}</span>
          ${examQuestionMeta(qId)}
        </div>
        <div class="q-text quiz-text">${escapeHtml(mcq ? mcq.stem : q.text)}</div>
        ${inputBlock}
      </div>
    `;
  }).join("");

  mainEl.innerHTML = `
    <div class="cat-header">
      <h2>📝 PSM 수준평가</h2>
      <p class="cat-desc">12대 요소에서 골고루 출제된 ${ids.length}문항입니다. 모두 응답한 뒤 하단의 채점하기 버튼을 눌러주세요.</p>
      ${subj ? `<div class="cat-score-badge">응시자: <strong>${escapeHtml(subj)}</strong></div>` : ""}
      <div class="cat-score-badge" id="exam-answered-badge">응답 현황: <strong>${answeredCount} / ${ids.length}</strong></div>
    </div>
    <div class="exam-list">
      ${items}
    </div>
    <div class="exam-submit-bar">
      <button class="btn-primary btn-submit" id="btn-submit-exam">채점하기 (제출)</button>
    </div>
  `;

  function refreshAnsweredBadge() {
    const badge = document.getElementById("exam-answered-badge");
    if (badge) badge.innerHTML = `응답 현황: <strong>${ids.filter(isExamAnswered).length} / ${ids.length}</strong>`;
  }

  mainEl.querySelectorAll(".exam-q-card").forEach(card => {
    const qid = card.dataset.qid;
    card.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener("change", () => {
        setExamAnswer(qid, { selected: Number(input.value) });
        renderProgressBar();
        renderSidebar();
        refreshAnsweredBadge();
        card.querySelectorAll(".exam-option").forEach(l => l.classList.remove("selected"));
        input.closest(".exam-option").classList.add("selected");
      });
    });
    const textEl = card.querySelector(".exam-text-answer");
    if (textEl) {
      textEl.addEventListener("input", () => {
        setExamAnswer(qid, { text: textEl.value });
        renderProgressBar();
        renderSidebar();
        refreshAnsweredBadge();
      });
    }
  });

  document.getElementById("btn-submit-exam").addEventListener("click", () => {
    const unanswered = ids.length - ids.filter(isExamAnswered).length;
    const msg = unanswered > 0
      ? `아직 응답하지 않은 문항이 ${unanswered}개 있습니다. 이대로 채점하시겠습니까?`
      : "평가를 종료하고 채점합니다. 계속하시겠습니까?";
    if (!confirm(msg)) return;
    submitExam();
  });
}

function gradeExamQuestion(qId) {
  const { q } = QUESTION_INDEX[qId];
  const mcq = parseMCQ(q.text);
  const a = getExamAnswer(qId);
  if (mcq) {
    const correctNum = parseCorrectNum(q.answer);
    if (correctNum === null || a.selected === null || a.selected === undefined) {
      return { status: "unanswered", auto: true };
    }
    return { status: a.selected === correctNum ? "correct" : "incorrect", auto: true };
  }
  if (!a.text || !a.text.trim()) return { status: "unanswered", auto: false };
  const manual = state.exam.manualGrades[qId];
  if (manual === true) return { status: "correct", auto: false };
  if (manual === false) return { status: "incorrect", auto: false };
  return { status: "ungraded", auto: false };
}

function computeExamScore() {
  const ids = state.exam.questionIds || [];
  let correct = 0;
  let graded = 0;
  ids.forEach(qId => {
    const g = gradeExamQuestion(qId);
    if (g.status === "correct" || g.status === "incorrect") {
      graded += 1;
      if (g.status === "correct") correct += 1;
    }
  });
  const pct = graded > 0 ? Math.round((correct / graded) * 1000) / 10 : null;
  return { correct, graded, total: ids.length, pct };
}

function computeExamByCategory() {
  const ids = state.exam.questionIds || [];
  const byCat = {};
  const order = [];
  ids.forEach(qId => {
    const { cat } = QUESTION_INDEX[qId];
    if (!byCat[cat.id]) { byCat[cat.id] = { name: cat.name, correct: 0, graded: 0, total: 0 }; order.push(cat.id); }
    byCat[cat.id].total += 1;
    const st = gradeExamQuestion(qId);
    if (st.status === "correct" || st.status === "incorrect") {
      byCat[cat.id].graded += 1;
      if (st.status === "correct") byCat[cat.id].correct += 1;
    }
  });
  return order.map(id => byCat[id]);
}

function submitExam() {
  state.exam.submittedAt = new Date().toISOString();
  state.exam.phase = "submitted";
  saveState();
  upsertExamLog();
  render();
}

function buildExamLogEntry() {
  const ids = state.exam.questionIds || [];
  const score = computeExamScore();
  const g = gradeOf(score.pct);
  const byCategory = computeExamByCategory().map(c => ({
    name: c.name, correct: c.correct, graded: c.graded, total: c.total,
    pct: c.graded > 0 ? round1((c.correct / c.graded) * 100) : null
  }));
  const questions = ids.map(qId => {
    const { cat, q } = QUESTION_INDEX[qId];
    const mcq = parseMCQ(q.text);
    const a = getExamAnswer(qId);
    const st = gradeExamQuestion(qId);
    return {
      id: qId,
      category: cat.name,
      text: q.text,
      myAnswer: mcq ? (mcq.options.find(o => o.num === a.selected) || {}).label || "" : a.text,
      correctAnswer: q.answer,
      guide: q.guide,
      status: st.status
    };
  });
  return {
    id: state.exam.id,
    subject: { ...state.subject },
    meta: { ...state.meta },
    startedAt: state.exam.startedAt,
    submittedAt: state.exam.submittedAt,
    correct: score.correct, graded: score.graded, total: score.total, pct: score.pct,
    grade: g.grade,
    byCategory,
    questions
  };
}

function upsertExamLog() {
  if (!state.exam.id) return;
  const entry = buildExamLogEntry();
  const idx = state.examLog.findIndex(e => e.id === entry.id);
  if (idx >= 0) state.examLog[idx] = entry; else state.examLog.push(entry);
  saveState();
  sendResultToCloud(entry);
}

function renderExamReview() {
  const ids = state.exam.questionIds;
  const score = computeExamScore();
  const g = gradeOf(score.pct);
  const subj = [state.subject.department, state.subject.position, state.subject.name].filter(Boolean).join(" / ");
  const byCat = computeExamByCategory();

  const rows = ids.map((qId, i) => {
    const { q } = QUESTION_INDEX[qId];
    const mcq = parseMCQ(q.text);
    const a = getExamAnswer(qId);
    const st = gradeExamQuestion(qId);
    const badge = {
      correct: `<span class="exam-badge ok">정답</span>`,
      incorrect: `<span class="exam-badge no">오답</span>`,
      unanswered: `<span class="exam-badge na">미응답</span>`,
      ungraded: `<span class="exam-badge pending">채점 필요</span>`
    }[st.status];

    let myAnswerText = "";
    if (mcq) {
      const opt = mcq.options.find(o => o.num === a.selected);
      myAnswerText = opt ? opt.label : "(응답 없음)";
    } else {
      myAnswerText = a.text && a.text.trim() ? a.text : "(응답 없음)";
    }

    let manualGradeButtons = "";
    if (!mcq && a.text && a.text.trim()) {
      manualGradeButtons = `
        <div class="quiz-grade">
          <span class="quiz-grade-label">채점:</span>
          <button class="grade-btn grade-o ${state.exam.manualGrades[qId] === true ? "active" : ""}" data-manual-grade="${qId}" data-value="true">⭕ 정답 인정</button>
          <button class="grade-btn grade-x ${state.exam.manualGrades[qId] === false ? "active" : ""}" data-manual-grade="${qId}" data-value="false">❌ 오답 처리</button>
        </div>
      `;
    }

    return `
      <div class="exam-review-card">
        <div class="exam-q-head">
          <span class="exam-q-no">문항 ${i + 1}</span>
          ${examQuestionMeta(qId)}
          ${badge}
        </div>
        <div class="q-text quiz-text">${escapeHtml(mcq ? mcq.stem : q.text)}</div>
        <div class="exam-my-answer"><span class="exam-my-answer-label">내 답변</span> ${escapeHtml(myAnswerText)}</div>
        <div class="quiz-answer">
          <div class="quiz-answer-label">정답</div>
          <div class="quiz-answer-text">${escapeHtml(q.answer) || "(등록된 정답 없음)"}</div>
          ${q.guide ? `<div class="quiz-guide"><span class="quiz-guide-label">해설</span> ${escapeHtml(q.guide)}</div>` : ""}
        </div>
        ${manualGradeButtons}
      </div>
    `;
  }).join("");

  const catRows = byCat.map(c => {
    const pct = c.graded > 0 ? Math.round((c.correct / c.graded) * 1000) / 10 : null;
    const cg = gradeOf(pct);
    return `<tr><td>${c.name}</td><td>${c.graded}/${c.total}</td><td>${pct === null ? "-" : pct + "%"}</td><td><span class="grade-pill" style="background:${cg.color}">${cg.grade}</span></td></tr>`;
  }).join("");

  mainEl.innerHTML = `
    <div class="cat-header">
      <h2>📝 PSM 수준평가 결과</h2>
      <p class="cat-desc">${subj ? escapeHtml(subj) + " 님의 " : ""}평가 결과입니다.${score.graded < score.total ? " 서술형 문항은 채점 후 최종 점수에 반영됩니다." : ""}</p>
    </div>

    <div class="result-summary">
      <div class="result-overall" style="border-color:${g.color}">
        <div class="result-overall-label">종합 점수</div>
        <div class="result-overall-pct" style="color:${g.color}">${score.pct === null ? "-" : score.pct + "%"}</div>
        <div class="grade-pill big" style="background:${g.color}">${g.grade}등급 · ${g.label}</div>
        <div class="exam-score-sub">정답 ${score.correct} / 채점 ${score.graded} / 전체 ${score.total}문항</div>
      </div>
      <div class="result-radar">
        <canvas id="radar" width="360" height="360"></canvas>
      </div>
    </div>

    <table class="result-table">
      <thead><tr><th>PSM 요소</th><th>채점/출제</th><th>정답률</th><th>등급</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table>

    <div class="result-actions">
      <button class="btn-outline" id="btn-export">JSON 내보내기</button>
      <button class="btn-outline" id="btn-print">인쇄 / PDF 저장</button>
      <button class="btn-outline" id="btn-new-exam-2">🔀 새 평가 시작</button>
    </div>

    <h3 class="exam-review-heading">문항별 채점 결과</h3>
    <div class="exam-review-list">
      ${rows}
    </div>
  `;

  drawRadar(byCat.map(c => ({
    label: c.name,
    pct: c.graded > 0 ? Math.round((c.correct / c.graded) * 1000) / 10 : null
  })));

  mainEl.querySelectorAll("[data-manual-grade]").forEach(btn => {
    btn.addEventListener("click", () => {
      const qid = btn.dataset.manualGrade;
      const val = btn.dataset.value === "true";
      state.exam.manualGrades[qid] = val;
      saveState();
      upsertExamLog();
      renderExamReview();
    });
  });

  document.getElementById("btn-export").addEventListener("click", exportExamJson);
  document.getElementById("btn-print").addEventListener("click", () => window.print());
  document.getElementById("btn-new-exam-2").addEventListener("click", () => {
    if (!confirm("현재 평가 결과를 마치고 새 응시자 정보 입력화면으로 돌아갑니다. 계속하시겠습니까?")) return;
    resetToIntake();
    render();
  });
}

function exportExamJson() {
  const entry = buildExamLogEntry();
  const payload = { mode: "exam", generatedAt: new Date().toISOString(), ...entry };
  const name = [state.subject.department, state.subject.position, state.subject.name].filter(Boolean).join("_") || "응시자";
  downloadJson(payload, `PSM_수준평가_${name}_${state.meta.date}.json`);
}

// ================= 관리자: 응시자 결과 =================
function renderAdminResults() {
  const rows = state.examLog.slice().sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));

  mainEl.innerHTML = `
    <div class="cat-header">
      <h2>🧑‍💼 응시자 결과</h2>
      <p class="cat-desc">이 브라우저에서 진행된 PSM 수준평가 응시 기록입니다. 다른 PC에서 응시한 결과는 응시자가 내보낸 JSON 파일을 아래에서 가져오면 함께 볼 수 있습니다.</p>
    </div>
    <div class="admin-toolbar">
      <label class="btn-outline file-btn">📥 결과 파일 가져오기<input type="file" id="admin-import" accept="application/json" multiple hidden /></label>
      <button class="btn-outline" id="admin-export-all">📤 전체 내보내기</button>
      <button class="btn-danger" id="admin-clear-log">전체 기록 삭제</button>
    </div>
    <table class="result-table admin-log-table">
      <thead>
        <tr><th>제출일시</th><th>부서</th><th>직급</th><th>이름</th><th>점수</th><th>등급</th><th>정답/채점/전체</th><th></th></tr>
      </thead>
      <tbody>
        ${rows.length === 0 ? `<tr><td colspan="8" class="admin-empty">아직 기록된 응시 결과가 없습니다.</td></tr>` : rows.map(r => `
          <tr>
            <td>${formatDT(r.submittedAt)}</td>
            <td>${escapeHtml(r.subject.department)}</td>
            <td>${escapeHtml(r.subject.position)}</td>
            <td>${escapeHtml(r.subject.name)}</td>
            <td>${r.pct === null ? "-" : r.pct + "%"}</td>
            <td><span class="grade-pill" style="background:${gradeOf(r.pct).color}">${r.grade}</span></td>
            <td>${r.correct}/${r.graded}/${r.total}</td>
            <td class="admin-log-actions">
              <button class="btn-outline btn-sm" data-detail="${r.id}">상세</button>
              <button class="btn-danger btn-sm" data-remove="${r.id}">삭제</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    <div id="admin-detail-panel"></div>
  `;

  document.getElementById("admin-import").addEventListener("change", async e => {
    const files = [...e.target.files];
    for (const file of files) {
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const entry = importedPayloadToLogEntry(payload);
        if (entry) state.examLog.push(entry);
      } catch (err) {
        console.warn("가져오기 실패:", file.name, err);
      }
    }
    saveState();
    render();
  });

  document.getElementById("admin-export-all").addEventListener("click", () => {
    downloadJson({ exportedAt: new Date().toISOString(), results: state.examLog }, `PSM_수준평가_전체결과_${new Date().toISOString().slice(0, 10)}.json`);
  });

  document.getElementById("admin-clear-log").addEventListener("click", () => {
    if (!confirm("기록된 모든 응시 결과를 삭제합니다. 계속하시겠습니까?")) return;
    state.examLog = [];
    saveState();
    render();
  });

  mainEl.querySelectorAll("[data-detail]").forEach(btn => {
    btn.addEventListener("click", () => renderAdminDetail(btn.dataset.detail));
  });
  mainEl.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("이 응시 결과를 삭제하시겠습니까?")) return;
      state.examLog = state.examLog.filter(e => e.id !== btn.dataset.remove);
      saveState();
      render();
    });
  });
}

function importedPayloadToLogEntry(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.results)) {
    // 전체 내보내기 파일을 가져온 경우 첫 항목만 취급하지 않고, 호출부에서 배열 처리하도록 별도 반환
    return null;
  }
  if (!payload.questions) return null;
  const byCategory = {};
  const order = [];
  payload.questions.forEach(q => {
    if (!byCategory[q.category]) { byCategory[q.category] = { name: q.category, correct: 0, graded: 0, total: 0 }; order.push(q.category); }
    byCategory[q.category].total += 1;
    if (q.status === "correct" || q.status === "incorrect") {
      byCategory[q.category].graded += 1;
      if (q.status === "correct") byCategory[q.category].correct += 1;
    }
  });
  return {
    id: payload.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    subject: payload.subject || { department: "", position: "", name: "" },
    meta: payload.meta || { site: "", assessor: "", date: "" },
    startedAt: payload.startedAt || null,
    submittedAt: payload.submittedAt || payload.generatedAt || null,
    correct: payload.correct || 0,
    graded: payload.graded || 0,
    total: payload.total || (payload.questions ? payload.questions.length : 0),
    pct: payload.pct !== undefined ? payload.pct : payload.overallPct,
    grade: payload.grade && payload.grade.grade ? payload.grade.grade : (payload.grade || gradeOf(payload.pct).grade),
    byCategory: order.map(name => {
      const c = byCategory[name];
      return { name: c.name, correct: c.correct, graded: c.graded, total: c.total, pct: c.graded > 0 ? round1((c.correct / c.graded) * 100) : null };
    }),
    questions: payload.questions
  };
}

function renderAdminDetail(id) {
  const entry = state.examLog.find(e => e.id === id);
  const panel = document.getElementById("admin-detail-panel");
  if (!panel) return;
  if (!entry) { panel.innerHTML = ""; return; }

  const subj = [entry.subject.department, entry.subject.position, entry.subject.name].filter(Boolean).join(" / ");
  const rows = (entry.questions || []).map((q, i) => {
    const badge = {
      correct: `<span class="exam-badge ok">정답</span>`,
      incorrect: `<span class="exam-badge no">오답</span>`,
      unanswered: `<span class="exam-badge na">미응답</span>`,
      ungraded: `<span class="exam-badge pending">채점 필요</span>`
    }[q.status] || "";
    return `
      <div class="exam-review-card">
        <div class="exam-q-head">
          <span class="exam-q-no">문항 ${i + 1}</span>
          <span class="exam-q-cat">${escapeHtml(q.category)}</span>
          ${badge}
        </div>
        <div class="q-text quiz-text">${escapeHtml(q.text)}</div>
        <div class="exam-my-answer"><span class="exam-my-answer-label">응시자 답변</span> ${escapeHtml(q.myAnswer) || "(응답 없음)"}</div>
        <div class="quiz-answer">
          <div class="quiz-answer-label">정답</div>
          <div class="quiz-answer-text">${escapeHtml(q.correctAnswer) || "(등록된 정답 없음)"}</div>
          ${q.guide ? `<div class="quiz-guide"><span class="quiz-guide-label">해설</span> ${escapeHtml(q.guide)}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  panel.innerHTML = `
    <div class="admin-detail-header">
      <h3>${escapeHtml(subj)} 님 상세 결과</h3>
      <button class="btn-outline btn-sm" id="admin-detail-close">닫기</button>
    </div>
    <div class="exam-review-list">${rows}</div>
  `;
  document.getElementById("admin-detail-close").addEventListener("click", () => { panel.innerHTML = ""; });
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ================= 관리자: 분석 =================
function renderAdminAnalysis() {
  const logs = state.examLog;
  if (logs.length === 0) {
    mainEl.innerHTML = `
      <div class="cat-header">
        <h2>📊 분석</h2>
        <p class="cat-desc">분석할 응시 데이터가 없습니다. 응시자 결과 탭에서 결과가 쌓이면 여기에 통계가 표시됩니다.</p>
      </div>`;
    return;
  }

  const pcts = logs.map(l => l.pct).filter(v => v !== null && v !== undefined);
  const avgPct = pcts.length ? round1(avg(pcts)) : null;
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
  logs.forEach(l => { if (gradeCounts[l.grade] !== undefined) gradeCounts[l.grade]++; });

  const catAgg = {};
  const order = [];
  logs.forEach(l => (l.byCategory || []).forEach(c => {
    if (!catAgg[c.name]) { catAgg[c.name] = { correct: 0, graded: 0 }; order.push(c.name); }
    catAgg[c.name].correct += c.correct;
    catAgg[c.name].graded += c.graded;
  }));
  const catRows = QUESTION_BANK.categories
    .map(cat => cat.name)
    .filter(name => catAgg[name])
    .map(name => {
      const a = catAgg[name];
      const pct = a.graded > 0 ? round1((a.correct / a.graded) * 100) : null;
      return { name, pct, graded: a.graded };
    });

  mainEl.innerHTML = `
    <div class="cat-header">
      <h2>📊 분석</h2>
      <p class="cat-desc">전체 응시자 ${logs.length}명 기준 통계입니다.</p>
    </div>
    <div class="admin-stat-cards">
      <div class="admin-stat-card"><div class="stat-num">${logs.length}</div><div class="stat-label">총 응시자</div></div>
      <div class="admin-stat-card"><div class="stat-num">${avgPct === null ? "-" : avgPct + "%"}</div><div class="stat-label">평균 점수</div></div>
      <div class="admin-stat-card"><div class="stat-num">${gradeCounts.A}</div><div class="stat-label">A등급</div></div>
      <div class="admin-stat-card"><div class="stat-num">${gradeCounts.B}</div><div class="stat-label">B등급</div></div>
      <div class="admin-stat-card"><div class="stat-num">${gradeCounts.C}</div><div class="stat-label">C등급</div></div>
      <div class="admin-stat-card"><div class="stat-num">${gradeCounts.D}</div><div class="stat-label">D등급</div></div>
    </div>

    <div class="result-summary">
      <div class="result-radar"><canvas id="radar" width="360" height="360"></canvas></div>
    </div>

    <table class="result-table">
      <thead><tr><th>PSM 요소</th><th>채점 문항수</th><th>평균 정답률</th><th>등급</th></tr></thead>
      <tbody>
        ${catRows.map(c => {
          const g = gradeOf(c.pct);
          return `<tr><td>${c.name}</td><td>${c.graded}</td><td>${c.pct === null ? "-" : c.pct + "%"}</td><td><span class="grade-pill" style="background:${g.color}">${g.grade}</span></td></tr>`;
        }).join("")}
      </tbody>
    </table>
  `;

  drawRadar(catRows.map(c => ({ label: c.name, pct: c.pct })));
}

// ================= 레이더 차트 =================
function drawRadar(items) {
  const canvas = document.getElementById("radar");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 50;
  const n = items.length;
  if (n < 3) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#8a94a3";
    ctx.textAlign = "center";
    ctx.fillText("표시할 항목이 부족합니다", cx, cy);
    return;
  }
  const angleStep = (Math.PI * 2) / n;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#dfe3e8";
  ctx.fillStyle = "#8a94a3";
  ctx.font = "10px sans-serif";
  [0.25, 0.5, 0.75, 1].forEach(f => {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + angleStep * i;
      const x = cx + Math.cos(a) * radius * f;
      const y = cy + Math.sin(a) * radius * f;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  ctx.strokeStyle = "#c3cad4";
  items.forEach((item, i) => {
    const a = -Math.PI / 2 + angleStep * i;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();

    const lx = cx + Math.cos(a) * (radius + 26);
    const ly = cy + Math.sin(a) * (radius + 26);
    ctx.fillStyle = "#4a5568";
    ctx.textAlign = "center";
    ctx.fillText(item.label.replace(/^\d+\.\s*/, ""), lx, ly);
  });

  ctx.beginPath();
  items.forEach((item, i) => {
    const pct = item.pct === null ? 0 : item.pct / 100;
    const a = -Math.PI / 2 + angleStep * i;
    const x = cx + Math.cos(a) * radius * pct;
    const y = cy + Math.sin(a) * radius * pct;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(30,136,229,0.25)";
  ctx.strokeStyle = "#1e88e5";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
}

// ================= 관리자 진입 =================
function bindAdminEntry() {
  document.getElementById("btn-admin-entry").addEventListener("click", () => {
    if (adminAuthed) { appArea = "admin"; render(); return; }
    const pw = prompt("관리자 비밀번호를 입력하세요.");
    if (pw === null) return;
    if (pw === ADMIN_PASSWORD) {
      adminAuthed = true;
      appArea = "admin";
      adminView = "results";
      render();
    } else {
      alert("비밀번호가 올바르지 않습니다.");
    }
  });
}

// ================= 전체 렌더 =================
function render() {
  renderModeBar();
  renderProgressBar();
  renderSidebar();

  if (appArea === "admin") {
    if (adminView === "checklist") {
      if (checklistView === "result") renderChecklistResult();
      else {
        const cat = QUESTION_BANK.categories.find(c => c.id === checklistView) || QUESTION_BANK.categories[0];
        renderChecklistCategory(cat);
      }
    } else if (adminView === "analysis") {
      renderAdminAnalysis();
    } else {
      renderAdminResults();
    }
    return;
  }

  if (state.mode === "exam") {
    renderExamMode();
    return;
  }

  // study
  const cat = QUESTION_BANK.categories.find(c => c.id === studyView) || QUESTION_BANK.categories[0];
  renderStudyContent(cat);
}

// ---- 초기화 ----
loadState();
bindAdminEntry();
render();

// ---- 체크리스트 모드 점수 척도 (관리자 전용) ----
const SCORE_SCALE = [
  { value: 3, label: "우수", color: "#2e7d32" },
  { value: 2, label: "양호", color: "#1e88e5" },
  { value: 1, label: "보통", color: "#fb8c00" },
  { value: 0, label: "미흡", color: "#e53935" }
];
const MAX_SCORE = Math.max(...SCORE_SCALE.map(s => s.value));
const NA_VALUE = "na";

const GRADE_TABLE = [
  { min: 90, grade: "A", label: "우수", color: "#2e7d32" },
  { min: 75, grade: "B", label: "양호", color: "#1e88e5" },
  { min: 60, grade: "C", label: "보통(개선 필요)", color: "#fb8c00" },
  { min: 0, grade: "D", label: "미흡(시급 개선)", color: "#e53935" }
];

const EXAM_TOTAL_QUESTIONS = 25;
const STORAGE_KEY = "psm_assessment_v5";
const COMPANY_NAME = "씨지앤대산전력";

// 응시 결과를 자동으로 전송할 구글시트(Apps Script 웹앱) 주소.
// 이 주소는 "쓰기 전용 우체통"이라 결과를 받기만 하고, 결과를 읽는 것은
// 이 주소를 만든 구글시트 소유자만 가능합니다(시트가 비공개이기 때문).
const RESULTS_ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbzE32Dpz74iHOgp3zZxgBLw7zLptOO7VDaQLmVVQeNjHmjNqv3lcU7YtJLiySXN-n0/exec";

function sendResultToCloud(entry) {
  if (!RESULTS_ENDPOINT_URL || RESULTS_ENDPOINT_URL.indexOf("http") !== 0) return;
  fetch(RESULTS_ENDPOINT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(entry)
  }).catch(() => {
    // 네트워크 오류 등으로 실패해도 로컬 저장(localStorage)에는 이미 남아있으므로
    // 조용히 무시합니다. (JSON 내보내기로 수동 전달하는 방법은 계속 사용 가능)
  });
}

const MODE_LABEL = {
  exam: { name: "PSM 수준평가", icon: "📝" },
  study: { name: "요소별 학습", icon: "📚" }
};

// ---- 전역 문항 색인 ----
const QUESTION_INDEX = {}; // qId -> { cat, q }
QUESTION_BANK.categories.forEach(cat => {
  cat.questions.forEach(q => { QUESTION_INDEX[q.id] = { cat, q }; });
});

// ---- 화면 영역 상태 (세션 한정, 저장 안 함) ----
let appArea = "user";      // "user" | "admin"
let adminAuthed = false;
let adminView = "results"; // "checklist" | "results" | "analysis"
let checklistView = QUESTION_BANK.categories[0].id; // categoryId 또는 "result" (관리자 체크리스트용)
let studyView = QUESTION_BANK.categories[0].id;     // categoryId (요소별 학습용)

// ---- 영구 저장 상태 ----
let state = {
  meta: { date: new Date().toISOString().slice(0, 10) },
  subject: { department: "", position: "", name: "" },
  mode: "exam",
  checklist: {}, // { [catId]: { [qId]: { score: number|"na"|null, note: string } } }
  study: {},     // { [catId]: { done: bool } }
  exam: {
    phase: "intake",   // "intake" | "taking" | "submitted"
    id: null,
    questionIds: null,
    answers: {},        // { [qId]: { selected: number|null, text: string } }
    manualGrades: {},   // { [qId]: true|false }
    startedAt: null,
    submittedAt: null
  },
  examLog: [] // 관리자 화면에서 보는 응시자 결과 기록
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        ...state, ...parsed,
        meta: { ...state.meta, ...(parsed.meta || {}) },
        subject: { ...state.subject, ...(parsed.subject || {}) },
        exam: { ...state.exam, ...(parsed.exam || {}) },
        examLog: parsed.examLog || []
      };
    }
  } catch (e) {
    console.warn("저장된 데이터를 불러오지 못했습니다.", e);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(n) { return Math.round(n * 10) / 10; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function formatDT(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function gradeOf(pct) {
  if (pct === null || pct === undefined) return { grade: "-", label: "평가 미완료", color: "#9e9e9e" };
  return GRADE_TABLE.find(g => pct >= g.min);
}

function nextMin(g) {
  const idx = GRADE_TABLE.indexOf(g);
  return idx > 0 ? GRADE_TABLE[idx - 1].min - 0.1 + "% 미만" : "";
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
