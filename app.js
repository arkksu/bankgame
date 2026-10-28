/* Банковская игра — общий экран за столом: рендер и управление.
 *
 * Автономная версия: без сервера и без клавиатуры — только мышка.
 * Движок (engine.js) создаёт экраны, этот файл их рисует и передаёт
 * ответы игрока обратно в ui.resolve().
 *
 * Панели осмотра (Команды / Рынок / Колода / События / Решение ЦБ / Справка)
 * доступны в любой момент партии — как карточки на столе: можно встать
 * со своего места и посмотреть любые дела.
 */
"use strict";

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------- состояние страницы ----------

let db = null;               // CardDB — данные карточек
let ui = null;               // WebUI — мост «экран ↔ ответ»
let gameState = null;        // текущая партия — для панелей осмотра
let logLines = [];
let cbHistory = [];
let cbRound = 0;
let waiting = false;      // ответ отправлен, ждём следующий экран
let currentScreen = null; // последний экран
let turnBanner = null;    // баннер очереди (переиспользуется между экранами)
let lastAnswerAt = 0;     // защита от двойного клика: окно «холодной» кнопки
const ANSWER_COOLDOWN = 300; // мс

// ---------- запуск партии ----------

function startGame(cont) {
  let state = cont ? loadGame() : null;
  if (cont && !state) console.warn("Сохранение не прочиталось — новая партия.");
  // Получаем количество команд из слайдера
  const teamCount = Number($("#team-count").value);
  // Генерируем имена команд автоматически
  const teamNames = [];
  for (let i = 0; i < teamCount; i++) {
    teamNames.push(`Команда ${i + 1}`);
  }
  if (!state) state = newGame(db, teamNames);
  saveGame(state); // новая партия сразу кладётся в хранилище
  gameState = state;

  logLines = [];
  cbHistory = [];
  renderLogs();

  $("#start").classList.add("hidden");
  $("#end").classList.add("hidden");
  $("#topbar").classList.remove("hidden");
  $("#tab-game").classList.remove("hidden");

  runGame(state);
}

async function runGame(state) {
  const game = new Game(db, state, ui, saveGame);
  try {
    await game.runLoop();
    if (!state.scored) {
      const result = await game.finalCount();
      deleteSave();
      if (result) {
        appendResult({
          rounds: db.rounds,
          winner: result.winner,
          results: result.results,
          log: state.log,
        });
        showEnd("Партия завершена",
          `Победитель: ${result.winner}. Итоги сохранены в истории браузера (localStorage).`);
        renderHistory();
        return;
      }
    }
    deleteSave();
    showEnd("Партия завершена", "Итоги сохранены в истории браузера (localStorage).");
    renderHistory();
  } catch (e) {
    console.error("Ошибка движка:", e);
    showEnd("Ошибка движка", (e && e.message) ? e.message : String(e));
  }
}

function sendAnswer(value) {
  if (waiting) return;      // защита от двойного клика
  waiting = true;
  lastAnswerAt = Date.now();
  setWaiting(true);
  ui.resolve(value);        // движок продолжается в микротасках
}

function setWaiting(on) {
  const box = $("#control");
  // блокируем кнопки/ввод панели управления, чтобы двойной клик не отправил второй ответ
  for (const b of box.querySelectorAll("button, input")) b.disabled = on;
  $("#waiting").classList.toggle("hidden", !on);
}

$("#btn-new").addEventListener("click", () => startGame(false));
$("#btn-continue").addEventListener("click", () => startGame(true));

// ---------- вкладки: главная область и панель осмотра ----------

// Кнопки навигации
const NAV_BTN_SELECTORS = [
  "#nav-game-btn",
  "#nav-teams-btn",
  "#nav-market-btn",
  "#nav-deck-btn",
  "#logs-btn",
  "#cb-btn",
  "#help-btn",
];

// Текущая активная вкладка
let activeTab = "game";

// Показать контент вкладки и обновить состояние кнопок
function showTab(tabName) {
  // Скроем все tab-pane
  const tabPanes = document.querySelectorAll(".tab-pane");
  tabPanes.forEach(pane => pane.classList.add("hidden"));

  // Убери active с всех кнопок
  NAV_BTN_SELECTORS.forEach(sel => $(sel).classList.remove("active"));

  // Покажем нужную панель
  switch (tabName) {
    case "teams":
      renderTeamsPanel();
      $("#tab-teams").classList.remove("hidden");
      break;
    case "market":
      renderMarketPanel();
      $("#tab-market").classList.remove("hidden");
      break;
    case "deck":
      renderDeckPanel();
      $("#tab-deck").classList.remove("hidden");
      break;
    case "logs":
      renderLogsPanel();
      $("#tab-logs").classList.remove("hidden");
      break;
    case "cb":
      // CB — pop-up, рендерим в свою панель
      renderCbPanel();
      $("#tab-cb").classList.remove("hidden");
      break;
    case "help":
      renderHelpPanel();
      $("#tab-help").classList.remove("hidden");
      break;
    case "game":
    default:
      // Игра — основная область, просто показываем её панель.
      // Движок игры сам обновляет шапку через ui.onScreen при изменении состояния.
      $("#tab-game").classList.remove("hidden");
      break;
  }

  // Активируем кнопку текущей вкладки
  const activeBtn = $(`#nav-${tabName}-btn`);
  if (activeBtn) {
    activeBtn.classList.add("active");
  }

  activeTab = tabName;
}

// Инициализация кликов по вкладкам
for (const sel of NAV_BTN_SELECTORS) {
  const btn = $(sel);
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tabName = btn.id.replace("nav-", "").replace("-btn", "");
      showTab(tabName);
    });
  }
}

// CB button also toggles the pop-up via existing mechanism
// (the document click handler below will handle closing)

document.addEventListener("click", (e) => {
  // Не закрываем при клике на навигационные кнопки
  if (e.target.closest(".nav-btn")) return;
  
  // Закрываем все side-panel если клик был вне них
  const sidePanels = document.querySelectorAll(".side-panel:not(.hidden)");
  sidePanels.forEach(panel => {
    if (!panel.contains(e.target) && !panel.parentNode.contains(e.target)) {
      panel.classList.add("hidden");
    }
  });
  
  // Закрываем CB panel если клик был вне него
  const cbPanel = document.querySelector("#tab-cb:not(.hidden)");
  if (cbPanel && !cbPanel.contains(e.target)) {
    cbPanel.classList.add("hidden");
  }
});

// ---------- панели осмотра ----------

function panelHead(panel, title) {
  return el("div", { class: "panel-head" },
    el("span", { class: "panel-title", text: title }));
}

function togglePanel(sel) {
  const p = PANELS.find((x) => x.panel === sel);
  if (!p) return;
  const box = $(sel);
  const willOpen = box.classList.contains("hidden");
  for (const x of PANELS) $(x.panel).classList.add("hidden");
  if (willOpen) {
    p.render();
    box.classList.remove("hidden");
    box.scrollTop = 0;
  }
}

// Rendera functions now render into their respective tab-pane divs
function renderTeamsPanel() {
  const box = $("#tab-teams");
  box.replaceChildren(panelHead("#tab-teams", "Команды за столом"));
  if (!gameState) return;
  const turnName = currentScreen && currentScreen.ctx && currentScreen.ctx.table
    ? currentScreen.ctx.table.name : null;
  for (const t of gameState.teams) {
    box.append(renderTable(null, teamTableView(t, gameState, db), t.name === turnName));
    const used = (t.bid_used || []).length;
    box.append(el("div", { class: "hand-line",
      text: `Карточек скидки у «${t.name}»: ${t.bid_hand.length}`
        + (used ? ` (${used} сгорело, вернутся в след. раунде)` : "") }));
  }
}

function renderMarketPanel() {
  const box = $("#tab-market");
  box.replaceChildren(panelHead("#tab-market", "Рынок: торги и сделки у ЦБ"));
  if (!gameState) return;
  renderMarket(box, marketView(gameState, db));
}

function renderDeckPanel() {
  const box = $("#tab-deck");
  box.replaceChildren(panelHead("#tab-deck", "Колода: что осталось"));
  if (!gameState) return;
  deckList(box, "В колоде (ещё не выпали)", gameState.deck);
  deckList(box, "В сбросе", gameState.discard);
  deckList(box, "На торгах (лоты)", gameState.market_lots);
  const freeIds = [];
  for (const [id, n] of Object.entries(gameState.free_pool)) {
    for (let i = 0; i < n; i++) freeIds.push(id);
  }
  deckList(box, "Бесплатный пул у ЦБ", freeIds);
  box.append(el("div", { class: "muted deck-note",
    text: "Когда колода пустеет, сброс перемешивается и возвращается в игру." }));
}

function renderLogsPanel() {
  const box = $("#tab-logs");
  box.replaceChildren(panelHead("#tab-logs", "События партии"));
  const lines = gameState && gameState.log.length ? gameState.log : logLines;
  if (!lines.length) {
    box.append(el("div", { class: "muted", text: "Событий пока нет." }));
    return;
  }
  for (const line of lines.slice(-60)) {
    box.append(el("div", { class: "log-line", text: line }));
  }
  box.scrollTop = box.scrollHeight;
}

function renderCbPanel() {
  const box = $("#tab-cb");
  box.replaceChildren(panelHead("#tab-cb", "Решения ЦБ по раундам"));
  if (!cbHistory.length) {
    box.append(el("div", { class: "muted", text: "Партия ещё не начиналась." }));
    return;
  }
  for (const d of cbHistory) {
    box.append(el("div", { class: "cb-item" + (d.round === cbRound ? " now" : "") },
      el("div", { class: "cb-item-title", text: `Раунд ${d.round}: «${d.title}»` }),
      el("div", { class: "cb-item-text", text: d.text }),
    ));
  }
}

function renderHelpPanel() {
  const box = $("#tab-help");
  box.replaceChildren(panelHead("#tab-help", "Справка: как играть"));
  const steps = [
    ["ШАГ 1", "Решение ЦБ нового раунда и выкладка сделок на рынок."],
    ["ШАГ 2", "Каждая команда по очереди: взять долг у ЦБ, купить улучшение "
      + "или специализацию, вернуть долг, завершить ход."],
    ["ШАГ 3", "Торги: команды тайно ставят карточку скидки, побеждает большая "
      + "скидка. Затем каждая команда может взять бесплатную сделку у ЦБ."],
    ["ШАГ 4", "Расчёты: платежи по долгам и доходы по сделкам, проверка "
      + "сделок с истёкшим срокам кубиком, сдвиг конвейера, обмен прибыли "
      + "на Капитал."],
    ["ШАГ 5", "(только в 5-м раунде) вскрытие стресс-сценариев и "
      + "межбанковская торговля сделками."],
  ];
  const box2 = el("div", { class: "help-body" });
  for (const [k, v] of steps) {
    box2.append(el("div", { class: "help-step" },
      el("b", { text: k }), el("span", { text: " — " + v })));
  }
  box2.append(el("div", { class: "help-step" },
    el("b", { text: "Норматив" }),
    el("span", { text: " — Риск сделок не должен превышать Капитала." })));
  box2.append(el("div", { class: "help-step" },
    el("b", { text: "Очки в финале" }),
    el("span", { text: " — Капитал × 2 + Баланс ÷ 2 + (улучшения и "
      + "специализация) × 4." })));
  box2.append(el("div", { class: "help-step" },
    el("b", { text: "Управление" }),
    el("span", { text: " — только мышкой: кнопки под экраном, панели сверху. "
      + "Панель закрывается крестиком или кликом в любом месте экрана." })));
  box.append(box2);
}

// ---------- панели: контент ----------

function renderTeamsPanel() {
  const box = $("#tab-teams");
  box.replaceChildren(panelHead("#tab-teams", "Команды за столом"));
  if (!gameState) return;
  // чья очередь — по активному экрану (ctx.table показывается только для ходящей команды)
  const turnName = currentScreen && currentScreen.ctx && currentScreen.ctx.table
    ? currentScreen.ctx.table.name : null;
  for (const t of gameState.teams) {
    box.append(renderTable(null, teamTableView(t, gameState, db), t.name === turnName));
    const used = (t.bid_used || []).length;
    box.append(el("div", { class: "hand-line",
      text: `Карточек скидки у «${t.name}»: ${t.bid_hand.length}`
        + (used ? ` (${used} сгорело, вернутся в след. раунде)` : "") }));
  }
}

function renderMarketPanel() {
  const box = $("#tab-market");
  box.replaceChildren(panelHead("#tab-market", "Рынок: торги и сделки у ЦБ"));
  if (!gameState) return;
  renderMarket(box, marketView(gameState, db));
}

function countsById(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

function deckList(box, title, ids) {
  box.append(el("h3", { class: "deck-title", text: `${title}: ${ids.length}` }));
  if (!ids.length) {
    box.append(el("div", { class: "muted", text: "— пусто" }));
    return;
  }
  const counts = countsById(ids);
  // сортируем по имени карточки, как на столе
  const rows = [...counts.entries()]
    .map(([id, n]) => ({ name: (db.deals[id] || {}).name || id, n }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const list = el("div", { class: "deck-list" });
  for (const r of rows) {
    list.append(el("div", { class: "deck-item" },
      el("span", { class: "deck-name", text: r.name }),
      el("span", { class: "deck-count", text: `×${r.n}` })));
  }
  box.append(list);
}

function renderDeckPanel() {
  const box = $("#tab-deck");
  box.replaceChildren(panelHead("#tab-deck", "Колода: что осталось"));
  if (!gameState) return;
  deckList(box, "В колоде (ещё не выпали)", gameState.deck);
  deckList(box, "В сбросе", gameState.discard);
  deckList(box, "На торгах (лоты)", gameState.market_lots);
  const freeIds = [];
  for (const [id, n] of Object.entries(gameState.free_pool)) {
    for (let i = 0; i < n; i++) freeIds.push(id);
  }
  deckList(box, "Бесплатный пул у ЦБ", freeIds);
  box.append(el("div", { class: "muted deck-note",
    text: "Когда колода пустеет, сброс перемешивается и возвращается в игру." }));
}

function renderLogsPanel() {
  const box = $("#tab-logs");
  box.replaceChildren(panelHead("#tab-logs", "События партии"));
  const lines = gameState && gameState.log.length ? gameState.log : logLines;
  if (!lines.length) {
    box.append(el("div", { class: "muted", text: "Событий пока нет." }));
    return;
  }
  for (const line of lines.slice(-60)) {
    box.append(el("div", { class: "log-line", text: line }));
  }
  box.scrollTop = box.scrollHeight;
}

function renderCbPanel() {
  const box = $("#tab-cb");
  box.replaceChildren(panelHead("#tab-cb", "Решения ЦБ по раундам"));
  if (!cbHistory.length) {
    box.append(el("div", { class: "muted", text: "Партия ещё не начиналась." }));
    return;
  }
  for (const d of cbHistory) {
    box.append(el("div", { class: "cb-item" + (d.round === cbRound ? " now" : "") },
      el("div", { class: "cb-item-title", text: `Раунд ${d.round}: «${d.title}»` }),
      el("div", { class: "cb-item-text", text: d.text }),
    ));
  }
}

function renderHelpPanel() {
  const box = $("#tab-help");
  box.replaceChildren(panelHead("#tab-help", "Справка: как играть"));
  const steps = [
    ["ШАГ 1", "Решение ЦБ нового раунда и выкладка сделок на рынок."],
    ["ШАГ 2", "Каждая команда по очереди: взять долг у ЦБ, купить улучшение "
      + "или специализацию, вернуть долг, завершить ход."],
    ["ШАГ 3", "Торги: команды тайно ставят карточку скидки, побеждает большая "
      + "скидка. Затем каждая команда может взять бесплатную сделку у ЦБ."],
    ["ШАГ 4", "Расчёты: платежи по долгам и доходы по сделкам, проверка "
      + "сделок с истёкшим срокам кубиком, сдвиг конвейера, обмен прибыли "
      + "на Капитал."],
    ["ШАГ 5", "(только в 5-м раунде) вскрытие стресс-сценариев и "
      + "межбанковская торговля сделками."],
  ];
  const box2 = el("div", { class: "help-body" });
  for (const [k, v] of steps) {
    box2.append(el("div", { class: "help-step" },
      el("b", { text: k }), el("span", { text: " — " + v })));
  }
  box2.append(el("div", { class: "help-step" },
    el("b", { text: "Норматив" }),
    el("span", { text: " — Риск сделок не должен превышать Капитал команды." })));
  box2.append(el("div", { class: "help-step" },
    el("b", { text: "Очки в финале" }),
    el("span", { text: " — Капитал × 2 + Баланс ÷ 2 + (улучшения и "
      + "специализация) × 4." })));
  box2.append(el("div", { class: "help-step" },
    el("b", { text: "Управление" }),
    el("span", { text: " — только мышкой: кнопки под экраном, панели сверху. "
      + "Панель закрывается крестиком или кликом в любом месте экрана." })));
  box.append(box2);
}

function showEnd(title, text) {
  $("#end-title").textContent = title;
  $("#end-text").textContent = text;
  $("#end").classList.remove("hidden");
}

// ---------- история партий (localStorage) ----------

function renderHistory() {
  const box = $("#history");
  if (!box) return;
  const list = readResults();
  box.replaceChildren();
  if (!list.length) {
    box.append(el("div", { class: "muted", text: "История партий пока пуста." }));
    return;
  }
  box.append(el("h3", { text: `История партий: ${list.length}` }));
  for (const rec of list.slice(-8).reverse()) {
    const winner = rec.results && rec.results[0];
    box.append(el("div", { class: "hist-item" },
      el("span", { class: "hist-when", text: String(rec.finished_at || "") }),
      el("span", { class: "hist-winner", text: `Победил ${rec.winner}` }),
      winner ? el("span", { class: "muted",
        text: ` — ${winner.points} очк. (кап. ${winner.capital}, баланс ${winner.liquidity})` }) : null,
    ));
  }
}

// ---------- рендер экрана ----------

function renderScreen(screen) {
  currentScreen = screen;
  renderTopbar(screen.ctx && screen.ctx.header);
  renderCtx(screen.ctx || {});
  // баннер очереди — первым ребёнком панели управления (она sticky снизу)
  const table = screen.ctx && screen.ctx.table;
  if (table) {
    turnBanner.textContent = `Сейчас ходит: ${table.name}`;
    turnBanner.classList.remove("hidden");
  } else {
    turnBanner.classList.add("hidden");
  }
  renderControl(screen);
  // «холодная» кнопка: короткое окно после ответа, чтобы двойной клик
  // не попал в уже следующий экран
  const cooldown = ANSWER_COOLDOWN - (Date.now() - lastAnswerAt);
  if (cooldown > 0 && lastAnswerAt) {
    setTimeout(() => {
      waiting = false;
      setWaiting(false);
    }, cooldown);
  } else {
    waiting = false;
    setWaiting(false);
  }
  const logs = (screen.ctx && screen.ctx.logs) || [];
  if (logs.length) {
    logLines.push(...logs);
    if (logLines.length > 80) logLines = logLines.slice(-80);
  }
}

function renderLogs() {
  const box = $("#logs-panel");
  if (!box) return;
  box.replaceChildren(panelHead("#logs-panel", "События партии"));
  for (const line of logLines.slice(-40)) {
    box.append(el("div", { class: "log-line", text: line }));
  }
  box.scrollTop = box.scrollHeight;
}

function dots(total, current) {
  const wrap = el("span", { class: "stepper" });
  for (let i = 1; i <= total; i++) {
    wrap.append(el("span", {
      class: "step-dot" + (i < current ? " done" : i === current ? " now" : ""),
      text: String(i),
    }));
  }
  return wrap;
}

function renderTopbar(h) {
  const bar = $("#topbar");
  if (!h) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const round = $("#tb-round");
  round.replaceChildren(`Раунд `, dots(h.rounds, h.round),
                        ` ${h.round}/${h.rounds}`);
  const cb = $("#tb-cb");
  cb.textContent = `Решение ЦБ: «${h.cb_title}» ▾`;
  cb.title = h.cb_text || "";
  if (h.cb_history && h.cb_history.length) {
    cbHistory = h.cb_history;
    cbRound = h.round;
  }
  // «ШАГ 2/4 — ...» -> кружки шага + текст
  const m = /ШАГ (\d+)\/(\d+)(.*)/.exec(h.step || "");
  const step = $("#tb-step");
  step.replaceChildren();
  if (m) {
    step.append(dots(Number(m[2]), Number(m[1])),
                el("span", { class: "step-label", text: m[3].replace(/^ *— */, "") }));
  } else {
    step.textContent = h.step || "";
  }
  bar.classList.toggle("stress", !!(h.stress && h.stress.length));
}

function renderCtx(ctx) {
  const box = $("#ctx");
  box.replaceChildren();

  // очередь: карточка команды → статусы → рынок
  if (ctx.table) renderTable(box, ctx.table);
  if (ctx.notes && ctx.notes.length) {
    const p = el("div", { class: "notes" });
    for (const n of ctx.notes) p.append(el("div", { class: "note", text: n }));
    box.append(p);
  }
  if (ctx.market) renderMarket(box, ctx.market);
}

function dealCard(d, extraClass = "") {
  const card = el("div", { class: `deal ${extraClass}` },
    el("div", { class: "deal-name", text: d.name }),
    el("div", { class: "deal-line", text: `Вложить ${d.body} → чистый доход +${d.net}` }),
    el("div", { class: "deal-line", text: `Срок ${d.term} р. | ${d.income_text} | Риск ${d.risk}` }),
  );
  if (d.pro_req) {
    card.append(el("div", { class: "deal-pro", text: d.pro_req }));
  }
  return card;
}

function renderMarket(box, market) {
  const wrap = el("div", { class: "market" });
  const lots = el("div", { class: "market-col" },
    el("h3", { text: "Сделки на рынке (торг)" }));
  if (!market.lots.length) lots.append(el("div", { class: "muted", text: "— торгов нет" }));
  for (const d of market.lots) lots.append(dealCard(d, "lot"));
  const free = el("div", { class: "market-col" },
    el("h3", { text: "Бесплатные сделки у ЦБ" }));
  if (!market.free.length) free.append(el("div", { class: "muted", text: "— пусто" }));
  for (const d of market.free) {
    const card = dealCard(d, "free");
    card.append(el("div", { class: "muted", text: `осталось ${d.count} шт.` }));
    free.append(card);
  }
  wrap.append(lots, free);
  box.append(wrap);
}

function renderTable(box, t, turn = true) {
  const panel = el("div", { class: "table-panel" });
  panel.append(el("div", { class: "tp-name",
    text: (turn ? ">>> " : "") + t.name }));
  panel.append(el("div", { class: "tp-money" },
    el("span", { class: "tp-capital", text: `Капитал: ${t.capital}` }),
    el("span", { class: "tp-liq", text: `Баланс: ${t.liquidity}` }),
  ));
  const riskCls = t.risk_ok ? "tp-risk ok" : "tp-risk bad";
  panel.append(el("div", { class: riskCls,
    text: `Риск: ${t.risk}` }));
  if (!t.risk_ok) {
    panel.append(el("div", { class: "tp-warn", text: "!! Нужно уменьшить Риск или увеличить Капитал." }));
  }
  panel.append(el("div", { class: "tp-bank",
    text: `Банк: ${t.bank} (не больше ${t.deals_limit} сделок, расход ${t.monthly_cost}/р.)` }));

  const debts = el("div", { class: "tp-sec" }, el("h4", { text: "Долги" }));
  if (!t.funding.length) debts.append(el("div", { class: "muted", text: "— нет" }));
  for (const f of t.funding) {
    debts.append(el("div", { class: "tp-item",
      text: `${f.name}: +${f.got} сейчас, платёж ${f.pay}/р., ${f.term}` }));
  }

  const deals = el("div", { class: "tp-sec" }, el("h4", { text: "Сделки" }));
  if (!t.deals.length) deals.append(el("div", { class: "muted", text: "— нет" }));
  const byLeft = {};
  for (const d of t.deals) (byLeft[d.left] = byLeft[d.left] || []).push(d);
  for (const left of [3, 2, 1]) {
    if (!byLeft[left]) continue;
    deals.append(el("div", { class: "tp-years", text: `осталось ${left} р.` }));
    for (const d of byLeft[left]) {
      const eff = d.eff_risk !== d.risk ? `, риск на деле ${d.eff_risk}` : "";
      const disc = d.discount ? `, скидка ${d.discount}` : "";
      deals.append(el("div", { class: "tp-item",
        text: `${d.name}: вложено ${d.body}, ${d.income_text}, риск ${d.risk}${eff}${disc}` }));
    }
  }
  if (t.deals.length >= t.deals_limit) {
    deals.append(el("div", { class: "tp-warn", text: `!! сделок максимум (${t.deals.length})` }));
  }
  panel.append(debts, deals);
  if (t.improvements.length) {
    panel.append(el("div", { class: "tp-sec" },
      el("h4", { text: "Улучшения" }),
      el("div", { text: t.improvements.join(", ") })));
  }
  if (box) box.append(panel);
  return panel;
}

function renderStatus(box, rows) {
  const wrap = el("div", { class: "status-row" });
  rows.forEach((r, i) => {
    // клик по карточке — открыть полный стол этой команды
    wrap.append(el("div", { class: `status-card${r.risk_ok ? "" : " bad"}`,
      onclick: () => togglePanel("#teams-panel") },
      el("div", { class: "sc-name", text: r.name }),
      el("div", { class: "sc-line", text: `Капитал ${r.capital} | Баланс ${r.liquidity}` }),
      el("div", { class: "sc-line", text: `Риск ${r.risk}${r.risk_ok ? "" : " — больше капитала!"}` }),
      el("div", { class: "sc-line muted", text: `Сделок ${r.deals}, долгов ${r.funding}` }),
      el("div", { class: "sc-open", text: "открыть стол команды ⌄" }),
    ));
  });
  box.append(el("h3", { text: "Общий статус" }), wrap);
}

// ---------- Управление (кнопки/ввод) — только мышка ----------

function renderControl(screen) {
  const box = $("#control");
  box.replaceChildren();
  // баннер очереди — первым в sticky-панели
  if (turnBanner && !turnBanner.classList.contains("hidden")) box.append(turnBanner);
  const t = screen.type;

  if (t === "pause") {
    box.append(el("button", { class: "big-btn", onclick: () => sendAnswer(null) },
      screen.msg || "Продолжить"));
  } else if (t === "choice") {
    box.append(el("div", { class: "prompt", text: screen.prompt || "" }));
    const list = el("div", { class: "choices grid3x2" });
    screen.options.forEach((opt, i) => {
      list.append(el("button", { class: "choice-btn", onclick: () => sendAnswer(i) },
        opt.label));
    });
    box.append(list);
  } else if (t === "yes_no") {
    box.append(el("div", { class: "prompt", text: screen.prompt || "" }));
    box.append(el("div", { class: "choices two" },
      el("button", { class: "choice-btn yes", onclick: () => sendAnswer(true) }, "Да"),
      el("button", { class: "choice-btn no", onclick: () => sendAnswer(false) }, "Нет"),
    ));
  } else if (t === "input_number") {
    box.append(el("div", { class: "prompt", text: screen.prompt || "" }));
    const inp = el("input", { type: "number", min: String(screen.lo), max: String(screen.hi) });
    inp.value = String(screen.lo);
    const clamp = () => {
      let v = parseInt(inp.value, 10);
      if (isNaN(v)) v = screen.lo;
      inp.value = String(Math.max(screen.lo, Math.min(screen.hi, v)));
    };
    const step = (delta) => {
      const v = parseInt(inp.value, 10) || screen.lo;
      inp.value = String(Math.max(screen.lo, Math.min(screen.hi, v + delta)));
    };
    const go = () => {
      clamp();
      sendAnswer(parseInt(inp.value, 10));
    };
    inp.addEventListener("change", clamp);
    box.append(el("div", { class: "choices inline number-row" },
      el("button", { class: "step-btn", text: "−", onclick: () => step(-1) }),
      inp,
      el("button", { class: "step-btn", text: "+", onclick: () => step(1) }),
      el("button", { class: "big-btn", onclick: go }, "ОК"),
    ));
  } else if (t === "text") {
    box.append(el("div", { class: "prompt", text: screen.prompt || "" }));
    const inp = el("input", { type: "text" });
    inp.value = screen.default || "";
    const go = () => sendAnswer(inp.value);
    inp.addEventListener("change", go);
    box.append(el("div", { class: "choices inline" }, inp,
      el("button", { class: "big-btn", onclick: go }, "ОК")));
  } else if (t === "confirm") {
    box.append(el("div", { class: "confirm-title", text: screen.title }));
    const det = el("div", { class: "confirm-details" });
    for (const line of screen.details) det.append(el("div", { text: line }));
    box.append(det);
    box.append(el("div", { class: "choices two" },
      el("button", { class: "choice-btn yes", onclick: () => sendAnswer(true) },
        "Да, подтверждаю"),
      el("button", { class: "choice-btn no", onclick: () => sendAnswer(false) },
        "Отмена"),
    ));
  } else if (t === "dice") {
    const die = el("div", { class: "die", text: "?" });
    const btn = el("button", { class: "big-btn" }, "Бросить кубик");
    btn.addEventListener("click", () => {
      btn.disabled = true;
      let ticks = 0;
      const iv = setInterval(() => {
        die.textContent = String(1 + Math.floor(Math.random() * 6));
        if (++ticks >= 12) {
          clearInterval(iv);
          const val = 1 + Math.floor(Math.random() * 6);
          die.textContent = String(val);
          die.classList.add("done");
          setTimeout(() => sendAnswer(val), 700);
        }
      }, 80);
    });
    box.append(el("div", { class: "prompt", text: "Бросок кубика" }), die, btn);
  } else if (t === "final") {
    box.append(el("div", { class: "final-title", text: "ИТОГОВАЯ ТАБЛИЦА" }));
    const tbl = el("table", { class: "final-table" },
      el("thead", {}, el("tr", {},
        el("th", { text: "Место" }), el("th", { text: "Команда" }),
        el("th", { text: "Капитал" }), el("th", { text: "Баланс" }),
        el("th", { text: "Очки" }), el("th", { text: "Улучш." }),
        el("th", { text: "Банк" }))));
    const tbody = el("tbody", {});
    for (const r of screen.results) {
      tbody.append(el("tr", {},
        el("td", { text: String(r.place) }),
        el("td", { text: r.name + (r.eliminated ? " (лицензия отозвана)" : "") }),
        el("td", { text: String(r.capital) }),
        el("td", { text: String(r.liquidity) }),
        el("td", { text: String(r.points) }),
        el("td", { text: String(r.improvements) }),
        el("td", { text: r.bank })));
    }
    tbl.append(tbody);
    box.append(tbl);
    box.append(el("div", { class: "winner",
      text: `ПОБЕДИТЕЛЬ: ${screen.winner} — ${screen.points} очков!` }));
    box.append(el("button", { class: "big-btn", onclick: () => sendAnswer(null) }, "Готово"));
  }
}

// ---------- Стартовый экран: слайдер команд ----------

$("#team-count").addEventListener("input", (e) => {
  const n = Number(e.target.value);
  $("#team-count-label").textContent = String(n);
});

function init() {
  db = CardDB.load();
  const howtoRounds = $("#howto-rounds");
  if (howtoRounds) howtoRounds.textContent = String(db.rounds);
  ui = new WebUI();
  ui.onScreen = renderScreen;
  turnBanner = $("#turn-banner");

  renderHistory();
  $("#btn-continue").classList.toggle("hidden", !hasSave());
  $("#start").classList.remove("hidden");
  
  // По умолчанию активна кнопка "Игра" без вызова showTab
  const gameBtn = $("#nav-game-btn");
  if (gameBtn) {
    gameBtn.classList.add("active");
  }
}

init();
