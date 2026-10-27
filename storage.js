/* Хранилище данных партий в localStorage (вместо saves/save.json и results.jsonl). */
"use strict";

const SAVE_KEY = "bankgame.save.v1";
const RESULTS_KEY = "bankgame.results.v1";
const SAVE_VERSION = 1;
const MAX_RESULTS = 50;

function saveGame(state) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      version: SAVE_VERSION,
      saved_at: new Date().toISOString().slice(0, 19),
      state: state.toDict(),
    }));
  } catch (e) {
    console.error("Не удалось сохранить партию:", e);
  }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (payload.version !== SAVE_VERSION) return null;
    return GameState.fromDict(payload.state);
  } catch (e) {
    console.error("Сохранение не прочиталось:", e);
    return null;
  }
}

function hasSave() {
  try {
    return !!localStorage.getItem(SAVE_KEY);
  } catch (e) {
    return false;
  }
}

function deleteSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (e) { /* нет хранилища — нечего удалять */ }
}

function readResults() {
  try {
    const raw = localStorage.getItem(RESULTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function appendResult(record) {
  const list = readResults();
  const rec = { ...record, finished_at: new Date().toISOString().slice(0, 19) };
  list.push(rec);
  while (list.length > MAX_RESULTS) list.shift();
  try {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(list));
  } catch (e) {
    console.error("Не удалось записать итоги:", e);
  }
  return rec;
}

function clearResults() {
  try {
    localStorage.removeItem(RESULTS_KEY);
  } catch (e) { /* ignore */ }
}
