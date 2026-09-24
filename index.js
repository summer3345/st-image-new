/* ============================================================
 *  🎨 Image Generator · IPE v2.1.0
 *  SillyTavern 1.18+ 扩展
 *
 *  从 RP 正文提取场景描述，调用独立 API 生成英文生图提示词，
 *  注入回正文（默认 <draw>…</draw> 追加在楼尾）。
 *
 *  功能：分层提取、换画风重注入、楼层 🎨 按钮（手动触发）、
 *        多 API 预设、预设包导入导出、失败重试、请求打断。
 *
 *  v2.1：移除主题系统（跟随酒馆自带），移除自动触发（纯手动）。
 * ============================================================ */

const EXT_NAME = "image-prompt-extractor";
const IPE_VERSION = "2.1.0";

/* ---------- 常量 ---------- */
var IPE_DEFAULT_IMAGE_TEMPLATE = "<draw>{Description}</draw>";
var IPE_LEGACY_IMAGE_TEMPLATE  = "image###{Description}###";
var IPE_IMG_TPL_PH_RE = /\{(?:Description|Camera|Env|Mood|Chars|Pose)\}/g;

var IPE_IMG_LAYERS = ["camera", "env", "mood", "chars", "pose"];
var IPE_IMG_LAYER_LABEL = { camera: "镜头", env: "环境", mood: "氛围", chars: "人物", pose: "动作" };
var IPE_IMG_LAYER_ICON  = { camera: "📷", env: "🌆", mood: "🎞️", chars: "🧍", pose: "🤝" };
var IPE_IMG_LAYER_PH    = { camera: "{Camera}", env: "{Env}", mood: "{Mood}", chars: "{Chars}", pose: "{Pose}" };
var IPE_IMG_INHERIT = { env: true, mood: true };
var IPE_IMG_LAYERS_META_KEY = "ipe_img_layers_v1";
var IPE_IMG_NOCHANGE = "NO_CHANGE";
var ipeImgLayersFresh = false;

var IPE_DEFAULT_SYSTEM_PROMPT = "You extract concise visual image-generation descriptions from Chinese roleplay text. Output only the final English Description. Do not think aloud. Do not explain.";

var IPE_DEFAULT_EXTRACTION_RULES = "优先写可见画面：人物数量、姿态、表情、服装、环境、光线、氛围、镜头距离。不要写心理活动、内心独白、对话内容。";

var IPE_DEFAULT_ANCHOR_USAGE_GUIDE = [
    "以下角色锚点仅为候选资料库，不是强制全部使用。提取时请严格根据正文当前场景按需调用：",
    "1. 只调用正文中明确出场、且当前画面确实需要入镜的角色。",
    "2. 未出场、仅被提及、仅存在于回忆/对话/电话/聊天记录中的角色，不要加入当前画面。",
    "3. 单人场景只输出单人描述，双人场景只输出双人描述；只有正文明确存在多人同场互动时，才输出多人描述。",
    "4. 若正文只出现某一个角色，例如只出 char，则只调用 char 锚点；其他角色若未实际出场，一律忽略。",
    "5. 这些角色锚点只用于校准已出场角色的外貌，不用于凭空增加角色，不用于强行拼成双人图或多人图。",
    "6. 如果当前段落没有明确描写某个角色的入镜需求，就不要因为锚点里有这个人而主动生成他/她。"
].join("\n");

var DEFAULTS = {
    enabled: false,
    requestTimeout: 0,
    apiEndpoint: "", apiKey: "", model: "",
    systemPrompt: "", baseTemplate: "", characterAnchors: "", extractionRules: "", anchorUsageGuide: "",
    imgLayered: false,
    imgLockCamera: false, imgLockEnv: false, imgLockMood: false, imgLockChars: false, imgLockPose: false,
    supplementPresetsJson: "[]",
    baseTemplatesJson: "",
    activeBaseTemplate: "tpl_1",
    anchorPresetsJson: "",
    activeAnchorPreset: "anchor_1",
    rulePresetsJson: "",
    activeRulePreset: "rule_1",
    systemPromptPresetsJson: "",
    activeSystemPromptPreset: "sys_1"
};

/* ---------- 运行时状态 ---------- */
var initialized = false;
var processing = false;
var currentIdx = -1;
var currentDesc = "";
var ipeAbortController = null;
var ipeUserAbortRequested = false;
var ipeRetryTimer = null;

/* ============================================================
   工具函数
   ============================================================ */
function ctx() { return SillyTavern.getContext(); }
function cfg() { return ctx().extensionSettings[EXT_NAME] || {}; }

function ipeRootWindow() {
    try { if (window.top && window.top.document) return window.top; } catch(e) {}
    return window;
}
function ipeRootDocument() {
    try { var w = ipeRootWindow(); if (w && w.document) return w.document; } catch(e) {}
    return document;
}
function q(sel) { try { return ipeRootDocument().querySelector(sel); } catch(e) { return null; } }
function qa(sel) { try { return Array.prototype.slice.call(ipeRootDocument().querySelectorAll(sel)); } catch(e) { return []; } }
function esc(s) {
    var d = ipeRootDocument();
    var el = d.createElement("div"); el.textContent = String(s == null ? "" : s); return el.innerHTML;
}
function ipeMetaRoot() {
    try { var c = ctx(); var m = c.chatMetadata || c.chat_metadata; if (m && typeof m === "object") return m; } catch(e) {}
    return null;
}
function ipeFloorNo() {
    try { var c = ctx(); return (c && c.chat && c.chat.length) ? c.chat.length : 0; } catch(e) { return 0; }
}
function ipeSafeJsonParse(str, fallback) {
    try { var v = JSON.parse(str); return v != null ? v : fallback; } catch(e) { return fallback; }
}
function ipeMakeId(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function save(key, val) {
    try {
        var c = ctx();
        if (!c.extensionSettings[EXT_NAME]) c.extensionSettings[EXT_NAME] = {};
        c.extensionSettings[EXT_NAME][key] = val;
        if (typeof c.saveSettingsDebounced === "function") c.saveSettingsDebounced();
    } catch(e) { console.error("[IPE] save error:", key, e); }
}
function saveCritical(key, val) { save(key, val); }

function loadSettings() {
    try {
        var c = ctx();
        if (!c.extensionSettings[EXT_NAME]) c.extensionSettings[EXT_NAME] = {};
        var s = c.extensionSettings[EXT_NAME];
        for (var k in DEFAULTS) { if (!s.hasOwnProperty(k)) s[k] = DEFAULTS[k]; }
    } catch(e) { console.error("[IPE] loadSettings error:", e); }
}

/* ============================================================
   预设：API / 模板 / 锚点 / 规则 / SystemPrompt
   ============================================================ */
function ipeGetApiProfiles() {
    var list = ipeSafeJsonParse(cfg().apiProfilesJson, null);
    if (!Array.isArray(list) || !list.length)
        list = [{ id: "api_1", name: "默认", endpoint: cfg().apiEndpoint || "", key: cfg().apiKey || "", model: cfg().model || "" }];
    return list;
}
function ipeSaveApiProfiles(list) { save("apiProfilesJson", JSON.stringify(list || [])); }
function ipeGetActiveApiProfile() { return String(cfg().activeApiProfile || "api_1"); }
function ipeGetActiveApiItem() {
    var list = ipeGetApiProfiles(), id = ipeGetActiveApiProfile();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
}
function ipeApplyApiProfile(id) {
    var item = ipeGetApiProfiles().filter(function(p){ return p.id === id; })[0];
    if (!item) return;
    save("activeApiProfile", id);
    save("apiEndpoint", item.endpoint || "");
    save("apiKey", item.key || "");
    save("model", item.model || "");
    ipeRefreshApiUI();
}
function ipeAddApiProfile() {
    var list = ipeGetApiProfiles(), id = ipeMakeId("api");
    list.push({ id: id, name: "API " + (list.length + 1), endpoint: "", key: "", model: "" });
    ipeSaveApiProfiles(list); save("activeApiProfile", id); ipeRefreshApiUI();
}
function ipeDeleteApiProfile() {
    var list = ipeGetApiProfiles(); if (list.length <= 1) return;
    var id = ipeGetActiveApiProfile();
    list = list.filter(function(p){ return p.id !== id; });
    ipeSaveApiProfiles(list); save("activeApiProfile", list[0].id); ipeRefreshApiUI();
}

function ipeGetBaseTemplates() {
    var list = ipeSafeJsonParse(cfg().baseTemplatesJson, null);
    if (!Array.isArray(list) || !list.length)
        list = [{ id: "tpl_1", name: "默认", value: IPE_DEFAULT_IMAGE_TEMPLATE }];
    return list;
}
function ipeSaveBaseTemplates(list) { save("baseTemplatesJson", JSON.stringify(list || [])); }
function ipeGetActiveTemplateId() { return String(cfg().activeBaseTemplate || "tpl_1"); }
function ipeGetActiveTemplateItem() {
    var list = ipeGetBaseTemplates(), id = ipeGetActiveTemplateId();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
}
function ipeGetTemplateValue() { return String((ipeGetActiveTemplateItem() || {}).value || ""); }
function ipeAddTemplate() {
    var list = ipeGetBaseTemplates(), id = ipeMakeId("tpl");
    list.push({ id: id, name: "模板 " + (list.length + 1), value: IPE_DEFAULT_IMAGE_TEMPLATE });
    ipeSaveBaseTemplates(list); save("activeBaseTemplate", id); ipeRefreshTemplateEditors();
}
function ipeDeleteTemplate() {
    var list = ipeGetBaseTemplates(); if (list.length <= 1) return;
    var id = ipeGetActiveTemplateId();
    list = list.filter(function(t){ return t.id !== id; });
    ipeSaveBaseTemplates(list); save("activeBaseTemplate", list[0].id); ipeRefreshTemplateEditors();
}

function ipeGetAnchorPresets() {
    var list = ipeSafeJsonParse(cfg().anchorPresetsJson, null);
    if (!Array.isArray(list) || !list.length)
        list = [{ id: "anchor_1", name: "默认", value: "" }];
    return list;
}
function ipeSaveAnchorPresets(list) { save("anchorPresetsJson", JSON.stringify(list || [])); }
function ipeGetActiveAnchorId() { return String(cfg().activeAnchorPreset || "anchor_1"); }
function ipeGetActiveAnchorItem() {
    var list = ipeGetAnchorPresets(), id = ipeGetActiveAnchorId();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
}
function ipeGetAnchorValue() { return String((ipeGetActiveAnchorItem() || {}).value || cfg().characterAnchors || ""); }
function ipeGetAnchorUsageGuide() { var g = String(cfg().anchorUsageGuide || "").trim(); return g || IPE_DEFAULT_ANCHOR_USAGE_GUIDE; }
function ipeStripBuiltInAnchorGuide(text) { return String(text || "").trim(); }
function ipeAddAnchorPreset() {
    var list = ipeGetAnchorPresets(), id = ipeMakeId("anchor");
    list.push({ id: id, name: "锚点 " + (list.length + 1), value: "" });
    ipeSaveAnchorPresets(list); save("activeAnchorPreset", id); ipeRefreshAnchorEditors();
}
function ipeDeleteAnchorPreset() {
    var list = ipeGetAnchorPresets(); if (list.length <= 1) return;
    var id = ipeGetActiveAnchorId();
    list = list.filter(function(a){ return a.id !== id; });
    ipeSaveAnchorPresets(list); save("activeAnchorPreset", list[0].id); ipeRefreshAnchorEditors();
}

function ipeGetRulePresets() {
    var list = ipeSafeJsonParse(cfg().rulePresetsJson, null);
    if (!Array.isArray(list) || !list.length)
        list = [{ id: "rule_1", name: "默认", value: IPE_DEFAULT_EXTRACTION_RULES }];
    return list;
}
function ipeSaveRulePresets(list) { save("rulePresetsJson", JSON.stringify(list || [])); }
function ipeGetActiveRuleId() { return String(cfg().activeRulePreset || "rule_1"); }
function ipeGetActiveRuleItem() {
    var list = ipeGetRulePresets(), id = ipeGetActiveRuleId();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
}
function ipeGetRuleValue() { return String((ipeGetActiveRuleItem() || {}).value || cfg().extractionRules || ""); }
function ipeAddRulePreset() {
    var list = ipeGetRulePresets(), id = ipeMakeId("rule");
    list.push({ id: id, name: "规则 " + (list.length + 1), value: "" });
    ipeSaveRulePresets(list); save("activeRulePreset", id); ipeRefreshRuleEditors();
}
function ipeDeleteRulePreset() {
    var list = ipeGetRulePresets(); if (list.length <= 1) return;
    var id = ipeGetActiveRuleId();
    list = list.filter(function(r){ return r.id !== id; });
    ipeSaveRulePresets(list); save("activeRulePreset", list[0].id); ipeRefreshRuleEditors();
}

function ipeGetSystemPromptPresets() {
    var list = ipeSafeJsonParse(cfg().systemPromptPresetsJson, null);
    if (!Array.isArray(list) || !list.length)
        list = [
            { id: "sys_1", name: "默认", value: IPE_DEFAULT_SYSTEM_PROMPT },
            { id: "sys_emo", name: "情绪优先", value: "You are a visual scene extractor. Focus on emotional atmosphere, body language, and lighting. Output only the final English Description." }
        ];
    return list;
}
function ipeSaveSystemPromptPresets(list) { save("systemPromptPresetsJson", JSON.stringify(list || [])); }
function ipeGetActiveSysPromptId() { return String(cfg().activeSystemPromptPreset || "sys_1"); }
function ipeGetActiveSysPromptItem() {
    var list = ipeGetSystemPromptPresets(), id = ipeGetActiveSysPromptId();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
}
function ipeGetSystemPromptValue() { return String((ipeGetActiveSysPromptItem() || {}).value || cfg().systemPrompt || ""); }
function ipeAddSysPromptPreset() {
    var list = ipeGetSystemPromptPresets(), id = ipeMakeId("sys");
    list.push({ id: id, name: "SP " + (list.length + 1), value: "" });
    ipeSaveSystemPromptPresets(list); save("activeSystemPromptPreset", id); ipeRefreshSysPromptEditors();
}
function ipeDeleteSysPromptPreset() {
    var list = ipeGetSystemPromptPresets(); if (list.length <= 1) return;
    var id = ipeGetActiveSysPromptId();
    list = list.filter(function(s){ return s.id !== id; });
    ipeSaveSystemPromptPresets(list); save("activeSystemPromptPreset", list[0].id); ipeRefreshSysPromptEditors();
}

/* ============================================================
   模板填充
   ============================================================ */
function ipeImgTemplatePlaceholders(t) {
    var out = [], m;
    IPE_IMG_TPL_PH_RE.lastIndex = 0;
    while ((m = IPE_IMG_TPL_PH_RE.exec(String(t || "")))) out.push({ i: m.index, e: m.index + m[0].length });
    return out;
}
function ipeImgTemplateEnvelope(t) {
    var m = String(t || "").match(/^\s*<([A-Za-z][\w-]*)\s*>[\s\S]*<\/\1\s*>\s*$/);
    return m ? m[1] : "";
}
function ipeImgFillTemplate(tpl, vals) {
    var lines = String(tpl == null ? "" : tpl).split("\n");
    var multi = lines.length > 1;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var hadPh = false, allEmpty = true;
        var filled = lines[i].replace(IPE_IMG_TPL_PH_RE, function(m){
            if (!Object.prototype.hasOwnProperty.call(vals, m)) return m;
            hadPh = true;
            var v = String(vals[m] == null ? "" : vals[m]);
            if (v.trim()) allEmpty = false;
            return v;
        });
        if (multi && hadPh && allEmpty) continue;
        out.push(filled);
    }
    return out.join("\n");
}

function buildInjectTag(desc, layers) {
    var tpl = ipeGetTemplateValue() || cfg().baseTemplate || IPE_DEFAULT_IMAGE_TEMPLATE;
    desc = String(desc == null ? "" : desc);
    var vals = {}, any = false;
    var hasDesc = tpl.indexOf("{Description}") >= 0;
    IPE_IMG_LAYERS.forEach(function(l){
        var ph = IPE_IMG_LAYER_PH[l];
        if (tpl.indexOf(ph) < 0) return;
        any = true;
        vals[ph] = layers ? String(layers[l] || "").trim() : "";
    });
    if (layers && any) {
        var used = {};
        IPE_IMG_LAYERS.forEach(function(l){ if (tpl.indexOf(IPE_IMG_LAYER_PH[l]) >= 0) used[l] = true; });
        desc = ipeImgJoinLayers(layers, used);
    }
    if (hasDesc) { vals["{Description}"] = desc; return ipeImgFillTemplate(tpl, vals); }
    if (layers || !any) return ipeImgFillTemplate(tpl, vals) + desc;
    var phs = ipeImgTemplatePlaceholders(tpl);
    return tpl.slice(0, phs[0].i) + desc + tpl.slice(phs[phs.length - 1].e);
}

/* ============================================================
   分层提取
   ============================================================ */
function ipeImgLayeredOn() { return cfg().imgLayered === true; }
function ipeImgLockKey(l) { return "imgLock" + l.charAt(0).toUpperCase() + l.slice(1); }
function ipeImgLocks(override) {
    var out = {};
    IPE_IMG_LAYERS.forEach(function(l){ out[l] = override ? !!override[l] : cfg()[ipeImgLockKey(l)] === true; });
    return out;
}
function ipeImgLayersRead() {
    try { var root = ipeMetaRoot(); var v = root && root[IPE_IMG_LAYERS_META_KEY]; if (v && typeof v === "object") return v; } catch(e) {}
    return null;
}
function ipeImgLayersSave(layers, floor) {
    try {
        var root = ipeMetaRoot(); if (!root) return;
        var o = { floor: Number(floor) || 0, envFloor: Number(layers && layers.envFloor) || Number(floor) || 0, moodFloor: Number(layers && layers.moodFloor) || Number(floor) || 0, updatedAt: Date.now() };
        IPE_IMG_LAYERS.forEach(function(l){ o[l] = String((layers && layers[l]) || ""); });
        root[IPE_IMG_LAYERS_META_KEY] = o;
        var c = ctx(); if (c && typeof c.saveMetadataDebounced === "function") c.saveMetadataDebounced();
    } catch(e) {}
}
function ipeImgLayerBoxValues() {
    var out = {};
    IPE_IMG_LAYERS.forEach(function(l){
        var a = q("#ipe-layer-" + l), b = q("#iped-layer-" + l);
        out[l] = String((a && a.value) || (b && b.value) || "").trim();
    });
    return out;
}
function ipeImgPrevLayers(locks) {
    var st = ipeImgLayersRead();
    var box = ipeImgLayerBoxValues();
    var out = { floor: st ? Number(st.floor) || 0 : 0, envFloor: st ? Number(st.envFloor || st.floor) || 0 : 0, moodFloor: st ? Number(st.moodFloor || st.floor) || 0 : 0 };
    IPE_IMG_LAYERS.forEach(function(l){
        var stored = st ? String(st[l] || "").trim() : "";
        if (ipeImgIsNoChange(stored)) stored = "";
        var boxV = String(box[l] || "").trim();
        if (ipeImgIsNoChange(boxV)) boxV = "";
        out[l] = (locks && locks[l] && boxV) ? boxV : stored;
    });
    return out;
}
function ipeImgLayerContract(prev, locks) {
    var lines = [
        "任务：把正文拆成五层英文生图描述，按下面五个标签分节输出。标签外不要写任何东西；不要解释；不要标题；不要代码块；不要中文。",
        "<camera>景别、机位高度、视角、构图、景深。一到两句。</camera>",
        "<env>只写物理空间：地点、室内外、时间段、天气、关键背景与道具、背景人物的数量与动态。不写光线质感和情绪。两到三句。</env>",
        "<mood>这一楼的画面感觉，用画面载体写而不是堆形容词：光的方向与质地、色温、明暗对比、空气感、天气细节、整体基调。一到三句。</mood>",
        "<chars>只写本楼实际出场且入镜的角色：按角色锚点校准外貌，再写此刻的服装状态、表情、身体状态。</chars>",
        "<pose>动作与空间关系，写成明确的空间句：谁在哪、面朝哪、视线落在哪、手放在哪、身体接触点、相对位置与距离。</pose>"
    ];
    var lockLines = [];
    IPE_IMG_LAYERS.forEach(function(l){
        if (locks && locks[l] && prev && String(prev[l] || "").trim()) lockLines.push("<" + l + ">" + prev[l] + "</" + l + ">");
    });
    if (lockLines.length) {
        lines.push("", "【已锁定的层 · 原样沿用，不要重写】", lockLines.join("\n"));
        lines.push("锁定层只输出 " + IPE_IMG_NOCHANGE + " 即可；其余层必须与锁定层保持一致。");
    }
    if (prev && String(prev.env || "").trim() && !(locks && locks.env)) {
        lines.push("", "【上一楼的环境层】", prev.env);
        lines.push("本楼地点、时间段、天气、道具都没变时，<env> 里只写 " + IPE_IMG_NOCHANGE + "。");
    }
    if (prev && String(prev.mood || "").trim() && !(locks && locks.mood)) {
        lines.push("", "【上一楼的氛围层】", prev.mood);
        lines.push("本楼光线、色温、情绪基调都没变时，<mood> 里只写 " + IPE_IMG_NOCHANGE + "。");
    }
    return lines.join("\n");
}
function ipeImgParseLayers(txt) {
    var s0 = String(txt || "").replace(/^\s*```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    var out = { found: 0 };
    IPE_IMG_LAYERS.forEach(function(l){
        var re = new RegExp("<\\s*" + l + "\\s*>([\\s\\S]*?)(?:<\\s*\\/\\s*" + l + "\\s*>|(?=<\\s*(?:camera|env|mood|chars|pose)\\s*>)|$)", "i");
        var m = s0.match(re);
        if (m) { out[l] = String(m[1] || "").trim(); out.found++; } else out[l] = "";
    });
    return out;
}
function ipeImgIsNoChange(v) {
    return String(v || "").replace(/[\s"'`*_\-.。!！,，;；:：()（）\[\]]/g, "").toUpperCase() === "NOCHANGE";
}
function ipeImgMergeLayers(parsed, prev, locks, floor) {
    var out = { notes: [], envFloor: Number(floor) || 0, moodFloor: Number(floor) || 0 };
    IPE_IMG_LAYERS.forEach(function(l){
        var v = String((parsed && parsed[l]) || "").trim();
        var prevV = prev ? String(prev[l] || "").trim() : "";
        if (ipeImgIsNoChange(prevV)) prevV = "";
        var label = IPE_IMG_LAYER_LABEL[l] || l;
        var fk = l + "Floor";
        var prevFloor = prev ? (Number(prev[fk]) || Number(prev.floor) || 0) : 0;
        if (locks && locks[l] && prevV) { out[l] = prevV; if (IPE_IMG_INHERIT[l]) out[fk] = prevFloor; return; }
        if (!v || ipeImgIsNoChange(v)) {
            if (prevV) {
                out[l] = prevV;
                if (IPE_IMG_INHERIT[l]) { out[fk] = prevFloor; out.notes.push(label + "沿用第 " + prevFloor + " 楼"); }
                else out.notes.push(label + "层沿用上一楼");
            } else { out[l] = ""; out.notes.push(label + "层为空"); }
            return;
        }
        out[l] = v;
    });
    return out;
}
function ipeImgJoinLayers(layers, skip) {
    var parts = [];
    IPE_IMG_LAYERS.forEach(function(l){
        if (skip && skip[l]) return;
        var v = String((layers && layers[l]) || "").trim();
        if (v) parts.push(v);
    });
    return parts.join(" ");
}
function ipeImgSetLayerBoxes(layers) {
    IPE_IMG_LAYERS.forEach(function(l){
        ["ipe-layer-", "iped-layer-"].forEach(function(pre){
            var el = q("#" + pre + l); if (el) el.value = String((layers && layers[l]) || "");
        });
    });
}
function ipeImgRefreshLayerUI() {
    var on = ipeImgLayeredOn();
    ["ipe-layered", "iped-layered"].forEach(function(id){ var el = q("#" + id); if (el) el.checked = on; });
    ["ipe-layers-box", "iped-layers-box"].forEach(function(id){ var el = q("#" + id); if (el) el.style.display = on ? "" : "none"; });
    IPE_IMG_LAYERS.forEach(function(l){
        ["ipe-lock-", "iped-lock-"].forEach(function(pre){
            var el = q("#" + pre + l); if (el) el.checked = cfg()[ipeImgLockKey(l)] === true;
        });
    });
    var st = ipeImgLayersRead();
    if (st) IPE_IMG_LAYERS.forEach(function(l){
        ["ipe-layer-", "iped-layer-"].forEach(function(pre){
            var el = q("#" + pre + l); if (el && !el.value) el.value = String(st[l] || "");
        });
    });
}

/* ============================================================
   正文处理
   ============================================================ */
function ipeExtractContentText(text) {
    text = String(text || "");
    var parts = [];
    var re = /<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
        if (m[1] && String(m[1]).trim()) parts.push(String(m[1]).trim());
    }
    return parts.length ? parts.join("\n\n") : text;
}
function ipeTrimSourceText(text) {
    text = ipeExtractContentText(text);
    var maxLen = 9000;
    if (text.length > maxLen) {
        text = text.slice(text.length - maxLen);
        text = "【注意：以下为正文末尾片段，前文已省略】\n" + text;
    }
    return text;
}
function ipeStripEnvelope(text, name) {
    var esc2 = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!esc2) return String(text || "");
    try { return String(text || "").replace(new RegExp("\\s*<" + esc2 + "\\s*>[\\s\\S]*?<\\/" + esc2 + "\\s*>", "g"), ""); } catch(e) { return String(text || ""); }
}
function ipeStripImageTag(text) {
    var out = String(text || "");
    var tpls = [];
    try { var list = ipeGetBaseTemplates(); if (Array.isArray(list)) list.forEach(function(x){ if (x && x.value) tpls.push(String(x.value)); }); } catch(e) {}
    try { if (cfg().baseTemplate) tpls.push(String(cfg().baseTemplate)); } catch(e) {}
    tpls.push(IPE_DEFAULT_IMAGE_TEMPLATE);
    tpls.push(IPE_LEGACY_IMAGE_TEMPLATE);
    var escFn = function(x){ return String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
    var stripTail = function(str, marker) { var k = str.lastIndexOf(marker); if (k < 0) return str; return str.slice(0, k).replace(/\s+$/, ""); };
    var seen = {};
    tpls.forEach(function(tpl){
        if (!tpl || seen[tpl]) return;
        seen[tpl] = true;
        var env = ipeImgTemplateEnvelope(tpl);
        if (env) { try { out = out.replace(new RegExp("\\s*<" + env + "\\s*>[\\s\\S]*?<\\/" + env + "\\s*>", "g"), ""); } catch(e) {} return; }
        var phs = ipeImgTemplatePlaceholders(tpl);
        if (!phs.length) { out = stripTail(out, tpl); return; }
        var prefix = tpl.slice(0, phs[0].i);
        if (prefix.trim()) out = stripTail(out, prefix.trim());
    });
    return out.replace(/\s+$/, "");
}

/* ============================================================
   API 调用
   ============================================================ */
function normalizeApiBase(base) {
    var url = (base || "").trim();
    if (!url) return "";
    while (url.length > 1 && url.charAt(url.length - 1) === "/") url = url.slice(0, -1);
    if (url.indexOf("/chat/completions") >= 0) url = url.replace(/\/chat\/completions\/?$/, "");
    if (url.indexOf("/models") >= 0) url = url.replace(/\/models\/?$/, "");
    if (!url.endsWith("/v1")) url += "/v1";
    return url;
}
function buildChatUrl(base) { var r = normalizeApiBase(base); return r ? r + "/chat/completions" : ""; }
function buildModelsUrl(base) { var r = normalizeApiBase(base); return r ? r + "/models" : ""; }

function ipeFetchWithTimeout(url, options, timeoutMs) {
    timeoutMs = Number(timeoutMs || 0);
    if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === "undefined") return fetch(url, options);
    if (timeoutMs < 30000) timeoutMs = 30000;
    options = options || {};
    var controller = new AbortController();
    var sig = options.signal;
    if (sig) { if (sig.aborted) { try { controller.abort(); } catch(e) {} } else { sig.addEventListener("abort", function(){ try { controller.abort(); } catch(e) {} }); } }
    options.signal = controller.signal;
    return new Promise(function(resolve, reject){
        var t = setTimeout(function(){ try { controller.abort(); } catch(e) {} reject(new Error("请求超时 (" + timeoutMs + "ms)")); }, timeoutMs);
        fetch(url, options).then(function(r){ clearTimeout(t); resolve(r); }, function(e){ clearTimeout(t); reject(e); });
    });
}

function parseChatResponse(data) {
    if (!data) return "";
    if (data.choices && data.choices[0]) {
        var ch = data.choices[0];
        if (ch.message) {
            var msg = ch.message;
            if (typeof msg.content === "string" && msg.content.trim()) return msg.content.trim();
            if (msg.content && Array.isArray(msg.content)) {
                var parts = [];
                msg.content.forEach(function(part) {
                    if (!part) return;
                    if (typeof part === "string") parts.push(part);
                    else if (typeof part === "object" && part.text) parts.push(String(part.text));
                });
                if (parts.length) return parts.join("").trim();
            }
        }
    }
    if (data.content && Array.isArray(data.content) && data.content[0]) {
        if (data.content[0].text) return String(data.content[0].text).trim();
        if (typeof data.content[0] === "string") return String(data.content[0]).trim();
    }
    if (data.response) return String(data.response).trim();
    if (data.text) return String(data.text).trim();
    if (data.output_text) return String(data.output_text).trim();
    return "";
}

function buildVisionUserPrompt(text, supplement, lockOverride) {
    var c = cfg();
    var user = "";
    var activeAnchors = ipeStripBuiltInAnchorGuide(ipeGetAnchorValue());
    if (activeAnchors) {
        user += "【角色锚点使用规则】\n" + ipeGetAnchorUsageGuide() + "\n\n";
        user += "【角色外貌锚点】\n" + activeAnchors + "\n\n";
    }
    var activeRules = ipeGetRuleValue();
    if (activeRules) user += "【提取规则】\n" + activeRules + "\n\n";
    user += "【正文内容】\n" + ipeTrimSourceText(text);
    if (supplement) user += "\n\n【补充指令】\n" + supplement;
    if (ipeImgLayeredOn()) {
        var locks = ipeImgLocks(lockOverride);
        user += "\n\n" + ipeImgLayerContract(ipeImgPrevLayers(locks), locks);
        return user;
    }
    user += "\n\n任务：把正文转成英文生图 Description。\n";
    user += "要求：只输出最终英文 Description；不要解释；不要标题；不要代码块；不要中文；不要复述任务。\n";
    user += "优先写可见画面：人物数量、姿态、表情、服装、环境、光线、氛围、镜头距离。";
    return user;
}

async function callAPI(text, supplement, lockOverride) {
    var c = cfg();
    if (!c.apiEndpoint) throw new Error("请先配置 API 地址");
    if (!c.model) throw new Error("请先加载并选择模型");
    var url = buildChatUrl(c.apiEndpoint);
    var url = buildChatUrl(c.apiEndpoint);
    var headers = { "Content-Type": "application/json" };
    if (c.apiKey) headers["Authorization"] = "Bearer " + c.apiKey;
    ipeUserAbortRequested = false;
    if (typeof AbortController !== "undefined") { ipeAbortController = new AbortController(); ipeSetStopButtonsState(true); }
    else ipeAbortController = null;
    var systemPrompt = ipeGetSystemPromptValue() || c.systemPrompt || IPE_DEFAULT_SYSTEM_PROMPT;
    var body = { model: c.model, messages: [ { role: "system", content: systemPrompt }, { role: "user", content: buildVisionUserPrompt(text, supplement || "", lockOverride) } ], temperature: 0.4, stream: false };
    var fetchOptions = { method: "POST", headers: headers, body: JSON.stringify(body) };
    if (ipeAbortController) fetchOptions.signal = ipeAbortController.signal;
    var res = await ipeFetchWithTimeout(url, fetchOptions, Number(cfg().requestTimeout || 0));
    var raw = await res.text();
    if (!res.ok) throw new Error("API " + res.status + "：" + raw.slice(0, 220));
    var data;
    try { data = JSON.parse(raw); } catch(e) { throw new Error("API 返回不是 JSON：" + raw.slice(0, 180)); }
    var out = parseChatResponse(data);
    if (out) return out;
    var finish = "";
    try { if (data.choices && data.choices[0] && data.choices[0].finish_reason) finish = data.choices[0].finish_reason; } catch(e) {}
    if (finish === "length") throw new Error("模型返回为空，finish_reason=length。请检查中转/模型是否有默认输出上限。");
    throw new Error("无法解析响应：" + raw.slice(0, 220));
}

/* ---------- 请求打断 ---------- */
function ipeAbortCurrentRequest() {
    try {
        if (ipeAbortController) {
            ipeUserAbortRequested = true;
            ipeAbortController.abort();
            ipeAbortController = null;
            ipeSetStopButtonsState(false);
            setStatus("已打断当前请求", "#d4726a");
        } else { ipeSetStopButtonsState(false); setStatus("当前没有进行中的请求", "#888"); }
    } catch(e) { setStatus("打断失败：" + e.message, "#d4726a"); }
}
function ipeSetStopButtonsState(on) {
    ["ipe-btn-stop", "iped-btn-stop"].forEach(function(id){ var b = q("#" + id); if (b) b.style.display = on ? "" : "none"; });
}

/* ---------- 重试 ---------- */
function ipeClearApiRetry() { if (ipeRetryTimer) { try { clearTimeout(ipeRetryTimer); } catch(e) {} ipeRetryTimer = null; } }
function ipeErrorText(e) {
    if (!e) return "未知错误";
    var msg = String(e.message || e || "未知错误");
    if (e.name === "AbortError" && !ipeUserAbortRequested) msg = "请求超时或连接被中止";
    return msg;
}
function ipeShouldRetryApiError(e, userAbort) {
    if (userAbort) return false;
    var msg = ipeErrorText(e);
    if (msg.indexOf("请先配置 API 地址") >= 0 || msg.indexOf("请先加载并选择模型") >= 0) return false;
    return true;
}
function ipeScheduleApiRetry(text, supplement, targetIdx, retryAttempt, msg, lockOverride) {
    ipeRetryTimer = setTimeout(function() {
        ipeRetryTimer = null;
        setStatus("自动重试中…（上次：" + msg + "）", "#c9a227");
        runExtract(text, supplement, targetIdx, retryAttempt + 1, lockOverride);
    }, 3000);
}
/* ============================================================
   UI 状态
   ============================================================ */
function setStatus(t, color) {
    ["#ipe-status", "#iped-status"].forEach(function(id){ var e = q(id); if (e) { e.textContent = t; e.style.color = color || ""; } });
}
function setPreview(t) {
    ["#ipe-preview-text", "#iped-preview-text"].forEach(function(id){ var e = q(id); if (e) { e.value = t; e.disabled = false; } });
}
function setBtns(r, j) {
    ["ipe", "iped"].forEach(function(p2){
        var br = q("#" + p2 + "-btn-reroll"), bj = q("#" + p2 + "-btn-inject");
        if (br) br.disabled = !r; if (bj) bj.disabled = !j;
    });
    ipeSetStopButtonsState(!!ipeAbortController);
}

/* ---------- 通知 ---------- */
function ipeToast(msg) { try { var c = ctx(); if (c.toastr) c.toastr.info(msg); else alert(msg); } catch(e) { alert(msg); } }
function ipeNotice(opts) {
    try {
        var c = ctx();
        if (opts.kind === "error" && c.toastr) c.toastr.error(opts.body || "", opts.title || "");
        else if (c.toastr) c.toastr.success(opts.body || "", opts.title || "");
        else alert((opts.title || "") + " " + (opts.body || ""));
    } catch(e) { alert((opts.title || "") + " " + (opts.body || "")); }
}

/* ============================================================
   提取 / 注入 / 重摇 核心流程
   ============================================================ */
async function runExtract(text, supplement, targetIdx, retryAttempt, lockOverride) {
    retryAttempt = retryAttempt || 0;
    if (processing) { setStatus("正在处理中，请稍候…", "#c9a227"); return; }
    if (!cfg().enabled) { setStatus("请先在设置面板开启生图提取", "#d4726a"); return; }
    processing = true;
    ipeClearApiRetry();
    ipeImgLayersFresh = false;
    try {
        setStatus("正在调用 API 提取…", "#c9a227");
        var raw = await callAPI(text, supplement, lockOverride);
        var desc = raw;
        var layerNote = "";
        if (ipeImgLayeredOn()) {
            var parsed = ipeImgParseLayers(raw);
            if (parsed.found > 0) {
                var locks = ipeImgLocks(lockOverride);
                var prev = ipeImgPrevLayers(locks);
                var floor = (typeof targetIdx === "number" ? targetIdx + 1 : ipeFloorNo());
                var merged = ipeImgMergeLayers(parsed, prev, locks, floor);
                merged.floor = floor;
                IPE_IMG_LAYERS.forEach(function(l){ if (!locks[l] && merged[l]) prev[l] = merged[l]; });
                prev.floor = floor;
                if (merged.envFloor) prev.envFloor = merged.envFloor;
                if (merged.moodFloor) prev.moodFloor = merged.moodFloor;
                ipeImgLayersSave(prev, floor);
                ipeImgSetLayerBoxes(merged);
                ipeImgLayersFresh = true;
                desc = ipeImgJoinLayers(merged);
                if (merged.notes && merged.notes.length) layerNote = "（" + merged.notes.join("；") + "）";
            }
        }
        currentDesc = desc;
        setPreview(desc);
        setStatus("提取完成 — 可编辑后确认注入" + layerNote, "#6ec577"); setBtns(true, true);
    } catch(e) {
        var userAbort = ipeUserAbortRequested;
        ipeUserAbortRequested = false;
        var emsg = ipeErrorText(e);
        if (ipeShouldRetryApiError(e, userAbort) && retryAttempt < 2) {
            setStatus("提取失败（" + emsg + "），3 秒后自动重试…", "#c9a227");
            ipeScheduleApiRetry(text, supplement, targetIdx, retryAttempt, emsg, lockOverride);
        } else {
            setStatus("提取失败：" + emsg, "#d4726a");
        }
    } finally {
        processing = false;
        ipeAbortController = null;
        ipeSetStopButtonsState(false);
    }
}

function onExtract() {
    var idx = currentIdx;
    if (idx < 0) {
        var chat = (ctx() && ctx().chat) || [];
        for (var k = chat.length - 1; k >= 0; k--) {
            var m = chat[k];
            if (m && !m.is_user && m.is_system !== true && String(m.mes || "").trim()) { idx = k; break; }
        }
    }
    if (idx < 0) { setStatus("找不到可提取的楼", "#d4726a"); return; }
    currentIdx = idx;
    var msg = ctx().chat[idx];
    if (!msg) { setStatus("消息不存在", "#d4726a"); return; }
    var supp = "";
    var s1 = q("#ipe-supplement"), s2 = q("#iped-supplement");
    if (s1 && s1.value) supp = s1.value; else if (s2 && s2.value) supp = s2.value;
    runExtract(msg.mes, supp, idx, 0, null);
}

function onReroll() {
    if (!currentDesc) { setStatus("请先提取一次", "#d4726a"); return; }
    var idx = currentIdx;
    if (idx < 0) { setStatus("请先提取一次", "#d4726a"); return; }
    var msg = ctx().chat[idx];
    if (!msg) return;
    var supp = "";
    var s1 = q("#ipe-supplement"), s2 = q("#iped-supplement");
    if (s1 && s1.value) supp = s1.value; else if (s2 && s2.value) supp = s2.value;
    runExtract(msg.mes, supp, idx, 0, null);
}

function onInject() {
    try {
        var idx = currentIdx;
        if (idx < 0) { setStatus("请先提取一次", "#d4726a"); return; }
        var r = injectDescToMessage("", idx);
        if (r.injected) {
            setStatus("已注入第 " + (idx + 1) + " 楼 ✓", "#6ec577"); setBtns(false, false);
            var s1 = q("#ipe-supplement"), s2 = q("#iped-supplement");
            if (s1) s1.value = ""; if (s2) s2.value = "";
        } else {
            setStatus("跳过注入（可能已注入）", "#c9a227");
        }
    } catch(e) { setStatus("注入失败：" + e.message, "#d4726a"); }
}

function onReinject() {
    try {
        var idx = currentIdx;
        if (idx < 0) { setStatus("请先提取一次", "#d4726a"); return; }
        var nm = String((ipeGetActiveTemplateItem() || {}).name || "");
        var r = reinjectDescToMessage(idx, { preferRecord: true });
        if (r.injected) {
            ipeNotice({ kind: "ok", title: "🎨 已换画风", body: "第 " + (r.idx + 1) + " 楼 → 「" + nm + "」" + (r.replaced ? "，旧的那块已替换" : "") });
            setStatus("已按「" + nm + "」重新注入第 " + (r.idx + 1) + " 楼 ✓", "#6ec577");
        } else {
            ipeNotice({ kind: "info", title: "🎨 没变", body: "第 " + (r.idx + 1) + " 楼已经是「" + nm + "」的注入" });
        }
    } catch(e) { ipeNotice({ kind: "error", title: "🎨 换画风失败", body: String(e && e.message || e) }); }
}

function onRerollLayer(layer) {
    if (!ipeImgLayeredOn()) { setStatus("分层未开启", "#d4726a"); return; }
    var idx = currentIdx;
    if (idx < 0) { setStatus("请先提取一次", "#d4726a"); return; }
    var msg = ctx().chat[idx];
    if (!msg) return;
    var lockOverride = {};
    IPE_IMG_LAYERS.forEach(function(l){ lockOverride[l] = (l === layer) ? false : true; });
    var supp = "";
    var s1 = q("#ipe-supplement"), s2 = q("#iped-supplement");
    if (s1 && s1.value) supp = s1.value; else if (s2 && s2.value) supp = s2.value;
    runExtract(msg.mes, supp, idx, 0, lockOverride);
}
/* ============================================================
   注入 / 重注入
   ============================================================ */
function ipeRememberInjectTag(msg, tag, desc, layers) {
    try {
        if (!msg.extra || typeof msg.extra !== "object") msg.extra = {};
        var envName = ipeImgTemplateEnvelope(tag);
        msg.extra.ipe_inject_env = envName || "";
        if (envName) delete msg.extra.ipe_inject_tag; else msg.extra.ipe_inject_tag = String(tag || "");
        msg.extra.ipe_inject_desc = String(desc || "");
        var ly = null;
        if (layers && typeof layers === "object") { ly = {}; IPE_IMG_LAYERS.forEach(function(l){ ly[l] = String(layers[l] || ""); }); }
        msg.extra.ipe_inject_layers = ly;
    } catch(e) {}
}
function ipeInjectRecord(msg) {
    try {
        var ex = msg && msg.extra;
        if (!ex || !String(ex.ipe_inject_desc || "").trim()) return null;
        var ly = (ex.ipe_inject_layers && typeof ex.ipe_inject_layers === "object" && ipeImgJoinLayers(ex.ipe_inject_layers)) ? ex.ipe_inject_layers : null;
        return { desc: String(ex.ipe_inject_desc), layers: ly };
    } catch(e) { return null; }
}
function ipeResolveInjectPayload(desc) {
    var pv = q("#ipe-preview-text"), pvd = q("#iped-preview-text");
    if (!desc) desc = (pv && pv.value) || (pvd && pvd.value) || currentDesc;
    var layers = null;
    if (ipeImgLayeredOn() && ipeImgLayersFresh) {
        var bx = ipeImgLayerBoxValues();
        if (ipeImgJoinLayers(bx)) layers = bx;
        if (!desc) desc = ipeImgJoinLayers(bx);
    }
    return { desc: String(desc || ""), layers: layers };
}

function injectDescToMessage(desc, targetIdx) {
    var idx = typeof targetIdx === "number" ? targetIdx : currentIdx;
    if (idx < 0) throw new Error("消息不存在");
    var p = ipeResolveInjectPayload(desc);
    desc = p.desc; var layers = p.layers;
    if (!desc) throw new Error("没有内容");
    var c = ctx();
    var msg = c.chat[idx];
    if (!msg) throw new Error("消息不存在");
    var tag = buildInjectTag(desc, layers);
    if (String(msg.mes || "").indexOf(tag) >= 0) return { injected: false, reason: "duplicate", tag: tag };
    msg.mes = String(msg.mes || "").trimEnd() + "\n\n" + tag;
    ipeRememberInjectTag(msg, tag, desc, layers);
    try { if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) && msg.swipe_id >= 0 && msg.swipe_id < msg.swipes.length) msg.swipes[msg.swipe_id] = msg.mes; } catch(eSw) {}
    if (typeof c.saveChat === "function") c.saveChat();
    var el = q('#chat .mes[mesid="' + idx + '"] .mes_text');
    if (el && el.innerHTML.indexOf(esc(tag)) < 0) el.insertAdjacentHTML("beforeend", "<p>" + esc(tag) + "</p>");
    try { ipeInstallMesButtons([q('#chat .mes[mesid="' + idx + '"]')]); } catch(eB) {}
    return { injected: true, tag: tag };
}

function reinjectDescToMessage(targetIdx, opts) {
    opts = opts || {};
    var c = ctx();
    var chat = c.chat || [];
    var idx = typeof targetIdx === "number" ? targetIdx : currentIdx;
    if (idx < 0) {
        for (var k = chat.length - 1; k >= 0; k--) {
            var m0 = chat[k];
            if (m0 && !m0.is_user && m0.is_system !== true && String(m0.mes || "").trim()) { idx = k; break; }
        }
    }
    if (idx < 0 || !chat[idx]) throw new Error("找不到要注入的楼");
    var msg = chat[idx];
    var rec = ipeInjectRecord(msg);
    var previewFirst = !opts.preferRecord && (idx === currentIdx || currentIdx < 0);
    var p = { desc: "", layers: null };
    if (previewFirst) {
        p = ipeResolveInjectPayload("");
        if (!p.layers && ipeImgLayeredOn()) {
            var st = ipeImgLayersRead(), bx = ipeImgLayerBoxValues();
            if (st && Number(st.floor) === idx + 1 && ipeImgJoinLayers(bx)) {
                p.layers = bx;
                if (!p.desc) p.desc = ipeImgJoinLayers(bx);
            }
        }
    }
    if (!p.desc && rec) p = { desc: rec.desc, layers: rec.layers };
    if (!p.desc) throw new Error(previewFirst ? "预览框是空的，先提取一次" : "这楼没有提取记录，先提取一次");
    var before = String(msg.mes || "");
    var stripped = before, prevTag = "", prevEnv = "";
    try {
        prevTag = String((msg.extra && msg.extra.ipe_inject_tag) || "");
        prevEnv = String((msg.extra && msg.extra.ipe_inject_env) || "");
        if (prevTag) { var kp = stripped.lastIndexOf(prevTag); if (kp >= 0) stripped = stripped.slice(0, kp) + stripped.slice(kp + prevTag.length); }
        if (prevEnv) stripped = ipeStripEnvelope(stripped, prevEnv);
    } catch(ePT) {}
    stripped = ipeStripImageTag(stripped);
    var tag = buildInjectTag(p.desc, p.layers);
    var next = stripped.replace(/\s+$/, "") + "\n\n" + tag;
    if (next === before) return { injected: false, reason: "same", tag: tag, idx: idx, replaced: false };
    msg.mes = next;
    ipeRememberInjectTag(msg, tag, p.desc, p.layers);
    try { if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) && msg.swipe_id >= 0 && msg.swipe_id < msg.swipes.length) msg.swipes[msg.swipe_id] = msg.mes; } catch(eSw) {}
    if (typeof c.saveChat === "function") c.saveChat();
    var el = q('#chat .mes[mesid="' + idx + '"] .mes_text');
    if (el) {
        try {
            if (prevEnv) el.innerHTML = ipeStripEnvelope(el.innerHTML, prevEnv);
            if (prevTag && el.innerHTML.indexOf(esc(prevTag)) >= 0) {
                var tmp = el.innerHTML.split(esc(prevTag));
                el.innerHTML = tmp.join("");
            }
        } catch(eCl) {}
        if (el.innerHTML.indexOf(esc(tag)) < 0) el.insertAdjacentHTML("beforeend", "<p>" + esc(tag) + "</p>");
    }
    try { ipeInstallMesButtons([q('#chat .mes[mesid="' + idx + '"]')]); } catch(eB) {}
    return { injected: true, tag: tag, idx: idx, replaced: stripped !== before };
}
/* ============================================================
   楼层 🎨 按钮 — 每条 AI 楼都挂一个生图按钮
   ============================================================ */
var IPE_MES_BTN_CLASS = "ipe-mes-gen";
var IPE_MES_REINJECT_CLASS = "ipe-mes-reinject";
function ipeInstallMesButtons(rows) {
    var d = ipeRootDocument();
    var chatEl = d.querySelector("#chat"); if (!chatEl) return 0;
    var chat = (ctx() && ctx().chat) || [];
    var n = 0;
    Array.prototype.slice.call(rows || chatEl.querySelectorAll(".mes")).forEach(function(m){
        if (!m || !m.isConnected || !chatEl.contains(m)) return;
        var idx = Number(m.getAttribute("mesid"));
        if (!Number.isFinite(idx)) return;
        var msg = chat[idx];
        if (!msg || msg.is_user) return;

        /* 生图按钮：每条 AI 楼都有 */
        var hasGen = m.querySelector("." + IPE_MES_BTN_CLASS);
        if (!hasGen) {
            var htmlGen = '<div title="🎨 生图：提取当前楼正文并注入生图标签" class="mes_button ' + IPE_MES_BTN_CLASS + ' fa-solid fa-image interactable" tabindex="0"></div>';
            var hint = m.querySelector(".mes_buttons .extraMesButtonsHint");
            var bar = m.querySelector(".mes_buttons") || m.querySelector(".extraMesButtons");
            if (hint) hint.insertAdjacentHTML("beforebegin", htmlGen);
            else if (bar) bar.insertAdjacentHTML("afterbegin", htmlGen);
            n++;
        }

        /* 换画风按钮：只有已注入记录的楼才有 */
        var hasReinject = m.querySelector("." + IPE_MES_REINJECT_CLASS);
        var wantReinject = !!ipeInjectRecord(msg);
        if (wantReinject && !hasReinject) {
            var htmlRe = '<div title="🎨 换画风：按当前模板重新注入这楼" class="mes_button ' + IPE_MES_REINJECT_CLASS + ' fa-solid fa-palette interactable" tabindex="0"></div>';
            var hint2 = m.querySelector(".mes_buttons .extraMesButtonsHint");
            var bar2 = m.querySelector(".mes_buttons") || m.querySelector(".extraMesButtons");
            if (hint2) hint2.insertAdjacentHTML("beforebegin", htmlRe);
            else if (bar2) bar2.insertAdjacentHTML("afterbegin", htmlRe);
        } else if (!wantReinject && hasReinject) { try { hasReinject.remove(); } catch(e) {} }
    });
    return n;
}
function ipeInstallMesButtonsObserver() {
    try {
        var d = ipeRootDocument();
        if (!d.querySelector("#chat") || typeof MutationObserver === "undefined") return;
        if (d.__ipeMesBtnObs) return;
        var t = null;
        var pendingRows = new Set();
        var mo = new MutationObserver(function(mutations){
            mutations.forEach(function(mu){
                if (mu.target && mu.target.closest && mu.target.closest(".mes_text")) return;
                if (mu.target && mu.target.closest && (mu.target.closest(".mes_buttons") || mu.target.closest(".extraMesButtons"))) {
                    var row = mu.target.closest(".mes"); if (row) pendingRows.add(row);
                }
                Array.prototype.forEach.call(mu.addedNodes || [], function(n){
                    if (!n || n.nodeType !== 1) return;
                    if (n.matches && n.matches(".mes")) pendingRows.add(n);
                    if (n.querySelectorAll) n.querySelectorAll(".mes").forEach(function(r){ pendingRows.add(r); });
                });
            });
            if (t) clearTimeout(t);
            t = setTimeout(function(){
                var rows = Array.from(pendingRows); pendingRows.clear();
                try { ipeInstallMesButtons(rows); } catch(e) {}
            }, 250);
        });
        mo.observe(d.querySelector("#chat"), { childList: true, subtree: true });
        d.__ipeMesBtnObs = mo;
        if (!d.__ipeMesBtnClick) {
            d.__ipeMesBtnClick = true;
            d.addEventListener("click", function(ev){
                var bGen = ev.target && ev.target.closest ? ev.target.closest("." + IPE_MES_BTN_CLASS) : null;
                var bRe = ev.target && ev.target.closest ? ev.target.closest("." + IPE_MES_REINJECT_CLASS) : null;
                if (!bGen && !bRe) return;
                ev.preventDefault(); ev.stopPropagation();
                var m = (bGen || bRe).closest(".mes"); var idx = m ? Number(m.getAttribute("mesid")) : NaN;
                if (!Number.isFinite(idx)) return;
                if (bGen) onGenImageForFloor(idx);
                else onReinjectFloor(idx);
            }, true);
        }
    } catch(e) {}
}

/* 点楼层 🎨 按钮 → 提取 + 自动注入 */
async function onGenImageForFloor(idx) {
    if (processing) { ipeToast("正在处理中，请稍候…"); return; }
    if (!cfg().enabled) { ipeToast("请先在设置面板开启生图提取"); return; }
    var c = ctx();
    var msg = c.chat && c.chat[idx];
    if (!msg || msg.is_user) return;
    currentIdx = idx;
    var supp = "";
    var s1 = q("#ipe-supplement"), s2 = q("#iped-supplement");
    if (s1 && s1.value) supp = s1.value; else if (s2 && s2.value) supp = s2.value;
    setStatus("🎨 正在第 " + (idx + 1) + " 楼提取…", "#c9a227");
    processing = true;
    ipeClearApiRetry();
    ipeImgLayersFresh = false;
    try {
        var raw = await callAPI(msg.mes, supp, null);
        var desc = raw;
        var layerNote = "";
        if (ipeImgLayeredOn()) {
            var parsed = ipeImgParseLayers(raw);
            if (parsed.found > 0) {
                var locks = ipeImgLocks(null);
                var prev = ipeImgPrevLayers(locks);
                var floor = idx + 1;
                var merged = ipeImgMergeLayers(parsed, prev, locks, floor);
                merged.floor = floor;
                IPE_IMG_LAYERS.forEach(function(l){ if (!locks[l] && merged[l]) prev[l] = merged[l]; });
                prev.floor = floor;
                if (merged.envFloor) prev.envFloor = merged.envFloor;
                if (merged.moodFloor) prev.moodFloor = merged.moodFloor;
                ipeImgLayersSave(prev, floor);
                ipeImgSetLayerBoxes(merged);
                ipeImgLayersFresh = true;
                desc = ipeImgJoinLayers(merged);
                if (merged.notes && merged.notes.length) layerNote = "（" + merged.notes.join("；") + "）";
            }
        }
        currentDesc = desc;
        setPreview(desc);
        /* 自动注入到该楼 */
        var r = injectDescToMessage(desc, idx);
        if (r.injected) {
            setStatus("🎨 第 " + (idx + 1) + " 楼提取并注入成功 ✓" + layerNote, "#6ec577");
            ipeNotice({ kind: "ok", title: "🎨 生图完成", body: "第 " + (idx + 1) + " 楼已注入生图标签" });
        } else {
            setStatus("🎨 第 " + (idx + 1) + " 楼提取完成，但跳过注入（可能已注入）" + layerNote, "#c9a227");
        }
    } catch(e) {
        var userAbort = ipeUserAbortRequested;
        ipeUserAbortRequested = false;
        var emsg = ipeErrorText(e);
        setStatus("🎨 第 " + (idx + 1) + " 楼提取失败：" + emsg, "#d4726a");
        ipeNotice({ kind: "error", title: "🎨 生图失败", body: emsg });
    } finally {
        processing = false;
        ipeAbortController = null;
        ipeSetStopButtonsState(false);
    }
}

function onReinjectFloor(idx) {
    var nm = String((ipeGetActiveTemplateItem() || {}).name || "");
    try {
        var r = reinjectDescToMessage(idx, { preferRecord: true });
        if (r.injected) {
            ipeNotice({ kind: "ok", title: "🎨 已换画风", body: "第 " + (r.idx + 1) + " 楼 → 「" + nm + "」" + (r.replaced ? "，旧的那块已替换" : "") });
            setStatus("已按「" + nm + "」重新注入第 " + (r.idx + 1) + " 楼 ✓", "#6ec577");
        } else {
            ipeNotice({ kind: "info", title: "🎨 没变", body: "第 " + (r.idx + 1) + " 楼已经是「" + nm + "」的注入" });
        }
    } catch(e) { ipeNotice({ kind: "error", title: "🎨 换画风失败", body: String(e && e.message || e) }); }
}

/* ============================================================
   补充指令
   ============================================================ */
function ipeGetSuppPresets() {
    var list = ipeSafeJsonParse(cfg().supplementPresetsJson, null);
    return Array.isArray(list) ? list.map(function(x){ return String(x || ""); }).filter(Boolean) : [];
}
function ipeSaveSuppPresets(list) { save("supplementPresetsJson", JSON.stringify(list || [])); ipeRefreshSuppPresets(); }
function ipeRefreshSuppPresets() {
    var list = ipeGetSuppPresets();
    ["ipe-supp-presets", "iped-supp-presets"].forEach(function(id){
        var el = q("#" + id); if (!el) return;
        var html = '<option value="">常用短语…</option>';
        list.forEach(function(s, i){ var label = s.length > 40 ? s.slice(0, 40) + "…" : s; html += '<option value="' + i + '">' + esc(label) + '</option>'; });
        el.innerHTML = html;
    });
}
function ipeSuppInputs() { return [q("#ipe-supplement"), q("#iped-supplement")].filter(Boolean); }
function ipeSuppFill(text) {
    var ins = ipeSuppInputs();
    var curv = ""; ins.forEach(function(el){ if (!curv && el.value) curv = el.value; });
    var cur = String(curv || "").trim();
    var next = !cur ? text : (cur.indexOf(text) >= 0 ? cur : cur + "；" + text);
    ins.forEach(function(el){ el.value = next; });
}

/* ============================================================
   预设包导入/导出
   ============================================================ */
function ipeImgPackExport(mode) {
    var pack = { version: IPE_VERSION, mode: mode || "all", templates: [], anchors: [], rules: [], sysPrompts: [] };
    if (mode === "all" || mode === "current") {
        pack.templates = ipeGetBaseTemplates();
        pack.anchors = ipeGetAnchorPresets();
        pack.rules = ipeGetRulePresets();
        pack.sysPrompts = ipeGetSystemPromptPresets();
    }
    if (mode === "anchors") pack.anchors = ipeGetAnchorPresets();
    var json = JSON.stringify(pack, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var a = ipeRootDocument().createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ipe-pack-" + (mode || "all") + "-" + Date.now() + ".json";
    a.click();
    ipeToast("已导出预设包");
}
function ipeImgPackImportText(text) {
    try {
        var pack = JSON.parse(text);
        if (!pack || typeof pack !== "object") throw new Error("无效的预设包");
        if (Array.isArray(pack.templates) && pack.templates.length) ipeSaveBaseTemplates(pack.templates);
        if (Array.isArray(pack.anchors) && pack.anchors.length) ipeSaveAnchorPresets(pack.anchors);
        if (Array.isArray(pack.rules) && pack.rules.length) ipeSaveRulePresets(pack.rules);
        if (Array.isArray(pack.sysPrompts) && pack.sysPrompts.length) ipeSaveSystemPromptPresets(pack.sysPrompts);
        ipeRefreshTemplateEditors(); ipeRefreshAnchorEditors(); ipeRefreshRuleEditors(); ipeRefreshSysPromptEditors();
        ipeToast("已导入预设包 ✓");
    } catch(e) { ipeToast("导入失败：" + e.message); }
}
/* ============================================================
   UI 刷新
   ============================================================ */
function ipeRefreshApiUI() {
    var item = ipeGetActiveApiItem();
    ["ipe-api-endpoint", "iped-api-endpoint"].forEach(function(id){ var el = q("#" + id); if (el) el.value = item.endpoint || ""; });
    ["ipe-api-key", "iped-api-key"].forEach(function(id){ var el = q("#" + id); if (el) el.value = item.key || ""; });
    ["ipe-model", "iped-model"].forEach(function(id){ var el = q("#" + id); if (el) el.value = item.model || ""; });
}

/* ---------- 拉取模型列表 ---------- */
async function ipeFetchModels() {
    var c = cfg();
    var endpoint = c.apiEndpoint || "";
    var apiKey = c.apiKey || "";
    if (!endpoint) { ipeToast("请先配置 API Endpoint"); return; }
    var btn = q("#ipe-btn-fetch-models");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ 拉取中…"; }
    try {
        var url = buildModelsUrl(endpoint);
        var headers = {};
        if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
        var res = await fetch(url, { method: "GET", headers: headers });
        var raw = await res.text();
        if (!res.ok) throw new Error("HTTP " + res.status + "：" + raw.slice(0, 200));
        var data = JSON.parse(raw);
        var models = [];
        if (Array.isArray(data.data)) {
            data.data.forEach(function(m){ if (m && m.id) models.push(String(m.id)); });
        } else if (Array.isArray(data.models)) {
            data.models.forEach(function(m){ if (typeof m === "string") models.push(m); else if (m && m.id) models.push(String(m.id)); });
        } else if (Array.isArray(data)) {
            data.forEach(function(m){ if (typeof m === "string") models.push(m); else if (m && m.id) models.push(String(m.id)); });
        }
        models.sort();
        var sel = q("#ipe-model-sel");
        if (sel) {
            var html = '<option value="">— 选择模型 (' + models.length + ") —</option>";
            var currentModel = cfg().model || "";
            models.forEach(function(m){
                var sel2 = (m === currentModel) ? " selected" : "";
                html += '<option value="' + esc(m) + '"' + sel2 + '>' + esc(m) + '</option>';
            });
            sel.innerHTML = html;
        }
        if (models.length === 0) {
            ipeToast("未拉取到模型，请检查 API 地址是否正确");
        } else {
            ipeToast("已拉取 " + models.length + " 个模型 ✓");
        }
    } catch(e) {
        ipeToast("拉取模型失败：" + (e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🔄 拉取模型"; }
    }
}

function ipeRefreshTemplateEditors() {
    var list = ipeGetBaseTemplates(), id = ipeGetActiveTemplateId();
    ["ipe-tpl-sel", "iped-tpl-sel"].forEach(function(sid){
        var sel = q("#" + sid); if (!sel) return;
        var html = "";
        list.forEach(function(t){ html += '<option value="' + t.id + '">' + esc(t.name) + '</option>'; });
        sel.innerHTML = html; sel.value = id;
    });
    var item = ipeGetActiveTemplateItem();
    ["ipe-tpl-name", "iped-tpl-name"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.name) || ""; });
    ["ipe-tpl-val", "iped-tpl-val"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.value) || ""; });
}
function ipeRefreshAnchorEditors() {
    var list = ipeGetAnchorPresets(), id = ipeGetActiveAnchorId();
    ["ipe-anchor-sel", "iped-anchor-sel"].forEach(function(sid){
        var sel = q("#" + sid); if (!sel) return;
        var html = "";
        list.forEach(function(a){ html += '<option value="' + a.id + '">' + esc(a.name) + '</option>'; });
        sel.innerHTML = html; sel.value = id;
    });
    var item = ipeGetActiveAnchorItem();
    ["ipe-anchor-name", "iped-anchor-name"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.name) || ""; });
    ["ipe-anchor-val", "iped-anchor-val"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.value) || ""; });
}
function ipeRefreshRuleEditors() {
    var list = ipeGetRulePresets(), id = ipeGetActiveRuleId();
    ["ipe-rule-sel", "iped-rule-sel"].forEach(function(sid){
        var sel = q("#" + sid); if (!sel) return;
        var html = "";
        list.forEach(function(r){ html += '<option value="' + r.id + '">' + esc(r.name) + '</option>'; });
        sel.innerHTML = html; sel.value = id;
    });
    var item = ipeGetActiveRuleItem();
    ["ipe-rule-name", "iped-rule-name"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.name) || ""; });
    ["ipe-rule-val", "iped-rule-val"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.value) || ""; });
}
function ipeRefreshSysPromptEditors() {
    var list = ipeGetSystemPromptPresets(), id = ipeGetActiveSysPromptId();
    ["ipe-sys-sel", "iped-sys-sel"].forEach(function(sid){
        var sel = q("#" + sid); if (!sel) return;
        var html = "";
        list.forEach(function(sp){ html += '<option value="' + sp.id + '">' + esc(sp.name) + '</option>'; });
        sel.innerHTML = html; sel.value = id;
    });
    var item = ipeGetActiveSysPromptItem();
    ["ipe-sys-name", "iped-sys-name"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.name) || ""; });
    ["ipe-sys-val", "iped-sys-val"].forEach(function(id){ var el = q("#" + id); if (el) el.value = (item && item.value) || ""; });
}
function ipeRefreshAll() {
    ipeRefreshApiUI();
    ipeRefreshTemplateEditors();
    ipeRefreshAnchorEditors();
    ipeRefreshRuleEditors();
    ipeRefreshSysPromptEditors();
    ipeImgRefreshLayerUI();
    ipeRefreshSuppPresets();
    ["ipe-enabled"].forEach(function(id){ var el = q("#" + id); if (el) el.checked = cfg().enabled === true; });
    ["ipe-timeout"].forEach(function(id){ var el = q("#" + id); if (el) el.value = cfg().requestTimeout || 0; });
    ["ipe-anchor-guide"].forEach(function(id){ var el = q("#" + id); if (el) el.value = ipeGetAnchorUsageGuide(); });
}
/* ============================================================
   事件绑定
   ============================================================ */
function bindAll() {
    var d = ipeRootDocument();

    /* 总开关 */
    ["ipe-enabled"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ save("enabled", el.checked); });
    });

    /* API 配置 */
    ["ipe-api-endpoint"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){
            var item = ipeGetActiveApiItem(); item.endpoint = el.value;
            var list = ipeGetApiProfiles(); list.forEach(function(pp){ if (pp.id === item.id) pp.endpoint = el.value; });
            ipeSaveApiProfiles(list); save("apiEndpoint", el.value);
        });
    });
    ["ipe-api-key"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){
            var item = ipeGetActiveApiItem(); item.key = el.value;
            var list = ipeGetApiProfiles(); list.forEach(function(pp){ if (pp.id === item.id) pp.key = el.value; });
            ipeSaveApiProfiles(list); save("apiKey", el.value);
        });
    });
    ["ipe-model"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){
            var item = ipeGetActiveApiItem(); item.model = el.value;
            var list = ipeGetApiProfiles(); list.forEach(function(pp){ if (pp.id === item.id) pp.model = el.value; });
            ipeSaveApiProfiles(list); save("model", el.value);
        });
    });

    /* API 预设切换 */
    ["ipe-api-profile"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ ipeApplyApiProfile(el.value); });
    });

    /* 提取 / 注入 / 重摇 / 打断 */
    ["ipe-btn-extract"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ onExtract(); });
    });
    ["ipe-btn-reroll"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ onReroll(); });
    });
    ["ipe-btn-inject"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ onInject(); });
    });
    ["ipe-btn-reinject"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ onReinject(); });
    });
    ["ipe-btn-stop"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeAbortCurrentRequest(); });
    });

    /* 超时 */
    ["ipe-timeout"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ save("requestTimeout", Math.max(0, Number(el.value) || 0)); });
    });

    /* 分层提取 */
    ["ipe-layered"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ save("imgLayered", el.checked); ipeImgRefreshLayerUI(); });
    });

    /* 五层锁定 */
    IPE_IMG_LAYERS.forEach(function(l){
        ["ipe-lock-"].forEach(function(pre){
            var el = q("#" + pre + l); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
            el.addEventListener("change", function(){ save(ipeImgLockKey(l), el.checked); });
        });
    });

    /* 五层只重摇 */
    IPE_IMG_LAYERS.forEach(function(l){
        ["ipe-reroll-"].forEach(function(pre){
            var el = q("#" + pre + l); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
            el.addEventListener("click", function(){ onRerollLayer(l); });
        });
    });

    /* 模板预设 */
    ["ipe-tpl-sel"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ save("activeBaseTemplate", el.value); ipeRefreshTemplateEditors(); });
    });
    ["ipe-tpl-name"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetBaseTemplates(), tid = ipeGetActiveTemplateId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === tid) { list[i].name = el.value; break; } }
            ipeSaveBaseTemplates(list);
            var sel = q("#" + id.replace("-name", "-sel")); if (sel) { var v = sel.value; sel.innerHTML = list.map(function(t){ return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join(''); sel.value = v; }
        });
    });
    ["ipe-tpl-val"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetBaseTemplates(), tid = ipeGetActiveTemplateId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === tid) { list[i].value = el.value; break; } }
            ipeSaveBaseTemplates(list);
        });
    });
    ["ipe-tpl-add"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeAddTemplate(); });
    });
    ["ipe-tpl-del"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeDeleteTemplate(); });
    });

    /* 角色锚点 */
    ["ipe-anchor-sel"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ save("activeAnchorPreset", el.value); ipeRefreshAnchorEditors(); });
    });
    ["ipe-anchor-name"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetAnchorPresets(), aid = ipeGetActiveAnchorId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === aid) { list[i].name = el.value; break; } }
            ipeSaveAnchorPresets(list);
        });
    });
    ["ipe-anchor-val"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetAnchorPresets(), aid = ipeGetActiveAnchorId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === aid) { list[i].value = el.value; break; } }
            ipeSaveAnchorPresets(list);
        });
    });
    ["ipe-anchor-add"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeAddAnchorPreset(); });
    });
    ["ipe-anchor-del"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeDeleteAnchorPreset(); });
    });

    /* 锚点使用规则 */
    ["ipe-anchor-guide"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){ save("anchorUsageGuide", el.value); });
    });

    /* 提取规则 */
    ["ipe-rule-sel"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ save("activeRulePreset", el.value); ipeRefreshRuleEditors(); });
    });
    ["ipe-rule-name"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetRulePresets(), rid = ipeGetActiveRuleId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === rid) { list[i].name = el.value; break; } }
            ipeSaveRulePresets(list);
        });
    });
    ["ipe-rule-val"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetRulePresets(), rid = ipeGetActiveRuleId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === rid) { list[i].value = el.value; break; } }
            ipeSaveRulePresets(list);
        });
    });
    ["ipe-rule-add"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeAddRulePreset(); });
    });
    ["ipe-rule-del"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeDeleteRulePreset(); });
    });

    /* System Prompt */
    ["ipe-sys-sel"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){ save("activeSystemPromptPreset", el.value); ipeRefreshSysPromptEditors(); });
    });
    ["ipe-sys-name"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetSystemPromptPresets(), sid = ipeGetActiveSysPromptId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === sid) { list[i].name = el.value; break; } }
            ipeSaveSystemPromptPresets(list);
        });
    });
    ["ipe-sys-val"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("input", function(){
            var list = ipeGetSystemPromptPresets(), sid = ipeGetActiveSysPromptId();
            for (var i = 0; i < list.length; i++) { if (list[i].id === sid) { list[i].value = el.value; break; } }
            ipeSaveSystemPromptPresets(list);
        });
    });
    ["ipe-sys-add"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeAddSysPromptPreset(); });
    });
    ["ipe-sys-del"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeDeleteSysPromptPreset(); });
    });

    /* 预设包导出/导入 */
    ["ipe-pack-export"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeImgPackExport("all"); });
    });
    ["ipe-pack-export-anchors"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){ ipeImgPackExport("anchors"); });
    });
    ["ipe-pack-import"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        var fi = q("#" + id.replace("import", "file"));
        if (el && fi) { el.addEventListener("click", function(){ try { fi.value = ""; fi.click(); } catch(e){} }); }
    });
    ["ipe-pack-file"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){
            var f = el.files && el.files[0]; if (!f) return;
            var r = new FileReader();
            r.onload = function(){ ipeImgPackImportText(r.result); };
            r.onerror = function(){ ipeToast("读文件失败"); };
            r.readAsText(f);
        });
    });

    /* 补充指令常用短语 */
    ["ipe-supp-presets"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("change", function(){
            if (el.value === "") return;
            var list = ipeGetSuppPresets();
            var idx2 = Number(el.value);
            if (Number.isFinite(idx2) && idx2 >= 0 && idx2 < list.length) ipeSuppFill(list[idx2]);
        });
    });
    ["ipe-supp-save"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){
            var v = ""; ipeSuppInputs().forEach(function(el2){ if (!v && el2.value) v = el2.value; });
            v = String(v || "").trim();
            if (!v) { setStatus("补充指令框是空的，先写一句再存", "#d4726a"); return; }
            var list = ipeGetSuppPresets();
            if (list.indexOf(v) < 0) list.push(v);
            ipeSaveSuppPresets(list);
            setStatus("已存为常用短语（共 " + list.length + " 条）", "#6ec577");
        });
    });
    ["ipe-supp-del"].forEach(function(id){
        var el = q("#" + id); if (!el || el.dataset.ipeBound) return; el.dataset.ipeBound = "1";
        el.addEventListener("click", function(){
            var sel = q("#ipe-supp-presets");
            var idx2 = sel ? Number(sel.value) : NaN;
            var list = ipeGetSuppPresets();
            if (!sel || sel.value === "" || !Number.isFinite(idx2) || idx2 < 0 || idx2 >= list.length) { setStatus("先在常用短语里选一条再删", "#d4726a"); return; }
            list.splice(idx2, 1);
            ipeSaveSuppPresets(list);
            setStatus("已删除这条常用短语", "#6ec577");
        });
    });

    /* 换聊天 → 刷新楼层按钮 */
    try {
        var cc = ctx();
        if (cc.eventSource && cc.event_types && cc.event_types.CHAT_CHANGED) {
            cc.eventSource.on(cc.event_types.CHAT_CHANGED, function(){
                setTimeout(function(){
                    try { ipeImgRefreshLayerUI(); } catch(eL) {}
                    try { ipeInstallMesButtonsObserver(); ipeInstallMesButtons(); } catch(eM) {}
                }, 200);
            });
            console.log("[IPE] 已绑定换聊天事件");
        }
    } catch(e) { console.log("[IPE] 换聊天事件绑定跳过"); }

    /* 消息事件 → 刷新楼层按钮（纯手动，不自动提取） */
    try {
        var cm = ctx();
        if (cm.eventSource && cm.event_types && cm.event_types.MESSAGE_RECEIVED) {
            cm.eventSource.on(cm.event_types.MESSAGE_RECEIVED, function(){
                setTimeout(function(){ try { ipeInstallMesButtons(); } catch(e) {} }, 300);
            });
            console.log("[IPE] 已绑定消息事件");
        }
    } catch(e) {}

    ipeRefreshAll();
}
/* ============================================================
   UI 构建
   ============================================================ */
function createUI() {
    var d = ipeRootDocument();
    if (d.getElementById("ipe-panel")) return;

    var html = ''
        + '<div id="ipe-panel" class="ipe-panel">'
        + '  <div class="ipe-panel-header" id="ipe-panel-toggle" title="点击展开/收起">'
        + '    <span class="ipe-title">🎨 Image Generator · IPE</span>'
        + '    <span class="ipe-drawer-arrow" id="ipe-drawer-arrow">▼</span>'
        + '  </div>'
        + '  <div id="ipe-panel-body" class="ipe-panel-body" style="display:none">'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-toggle"><span>⚙️ 总开关</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-body" style="display:none">'
        + '      <label class="ipe-toggle"><input type="checkbox" id="ipe-enabled"> 开启生图提取</label>'
        + '      <label class="ipe-field">请求超时(ms, 0=不限) <input type="number" id="ipe-timeout" class="text_pole" value="0" min="0" step="1000"></label>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-api"><span>🔌 API 配置</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-api-body" style="display:none">'
        + '      <label class="ipe-field">API 预设 <select id="ipe-api-profile" class="text_pole"></select></label>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-api-add" class="ipe-btn">➕ 新增</button>'
        + '        <button type="button" id="ipe-api-del" class="ipe-btn">🗑️ 删除</button>'
        + '      </div>'
        + '      <label class="ipe-field">Endpoint <input type="text" id="ipe-api-endpoint" class="text_pole" placeholder="https://api.example.com/v1"></label>'
        + '      <label class="ipe-field">API Key <input type="password" id="ipe-api-key" class="text_pole" placeholder="sk-..."></label>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-btn-fetch-models" class="ipe-btn">🔄 拉取模型</button>'
        + '      </div>'
        + '      <label class="ipe-field">Model <select id="ipe-model-sel" class="text_pole"><option value="">— 选择模型 —</option></select></label>'
        + '      <label class="ipe-field">或手动输入 <input type="text" id="ipe-model" class="text_pole" placeholder="gpt-4o"></label>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-tpl"><span>📝 基础模板</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-tpl-body" style="display:none">'
        + '      <label class="ipe-field">模板预设 <select id="ipe-tpl-sel" class="text_pole"></select></label>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-tpl-add" class="ipe-btn">➕ 新增</button>'
        + '        <button type="button" id="ipe-tpl-del" class="ipe-btn">🗑️ 删除</button>'
        + '      </div>'
        + '      <label class="ipe-field">名称 <input type="text" id="ipe-tpl-name" class="text_pole"></label>'
        + '      <label class="ipe-field">模板 <textarea id="ipe-tpl-val" class="text_pole" rows="3" placeholder="<draw>{Description}</draw>"></textarea></label>'
        + '      <div class="ipe-hint">占位符: {Description} {Camera} {Env} {Mood} {Chars} {Pose}</div>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-anchor"><span>🧍 角色锚点</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-anchor-body" style="display:none">'
        + '      <label class="ipe-field">锚点预设 <select id="ipe-anchor-sel" class="text_pole"></select></label>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-anchor-add" class="ipe-btn">➕ 新增</button>'
        + '        <button type="button" id="ipe-anchor-del" class="ipe-btn">🗑️ 删除</button>'
        + '      </div>'
        + '      <label class="ipe-field">名称 <input type="text" id="ipe-anchor-name" class="text_pole"></label>'
        + '      <label class="ipe-field">锚点内容 <textarea id="ipe-anchor-val" class="text_pole" rows="4" placeholder="角色外貌资料..."></textarea></label>'
        + '      <label class="ipe-field">使用规则 <textarea id="ipe-anchor-guide" class="text_pole" rows="4"></textarea></label>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-rule"><span>📋 提取规则</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-rule-body" style="display:none">'
        + '      <label class="ipe-field">规则预设 <select id="ipe-rule-sel" class="text_pole"></select></label>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-rule-add" class="ipe-btn">➕ 新增</button>'
        + '        <button type="button" id="ipe-rule-del" class="ipe-btn">🗑️ 删除</button>'
        + '      </div>'
        + '      <label class="ipe-field">名称 <input type="text" id="ipe-rule-name" class="text_pole"></label>'
        + '      <label class="ipe-field">规则 <textarea id="ipe-rule-val" class="text_pole" rows="3"></textarea></label>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-sys"><span>💬 System Prompt</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-sys-body" style="display:none">'
        + '      <label class="ipe-field">SP 预设 <select id="ipe-sys-sel" class="text_pole"></select></label>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-sys-add" class="ipe-btn">➕ 新增</button>'
        + '        <button type="button" id="ipe-sys-del" class="ipe-btn">🗑️ 删除</button>'
        + '      </div>'
        + '      <label class="ipe-field">名称 <input type="text" id="ipe-sys-name" class="text_pole"></label>'
        + '      <label class="ipe-field">System Prompt <textarea id="ipe-sys-val" class="text_pole" rows="3"></textarea></label>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-layer"><span>🎨 分层提取</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-layer-body" style="display:none">'
        + '      <label class="ipe-toggle"><input type="checkbox" id="ipe-layered"> 开启分层</label>'
        + '      <div id="ipe-layers-box" style="display:none">'
        + ipeImgLayerRowsHTML("ipe", false)
        + '      </div>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-pack"><span>📦 预设包</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-pack-body" style="display:none">'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-pack-export" class="ipe-btn">📤 导出全部</button>'
        + '        <button type="button" id="ipe-pack-export-anchors" class="ipe-btn">📤 导出锚点</button>'
        + '        <button type="button" id="ipe-pack-import" class="ipe-btn">📥 导入</button>'
        + '        <input type="file" id="ipe-pack-file" accept=".json" style="display:none">'
        + '      </div>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section">'
        + '    <div class="ipe-section-header" id="ipe-sh-supp"><span>🔍 补充指令</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-supp-body" style="display:none">'
        + '      <label class="ipe-field">常用短语 <select id="ipe-supp-presets" class="text_pole"><option value="">常用短语…</option></select></label>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-supp-save" class="ipe-btn">💾 存当前</button>'
        + '        <button type="button" id="ipe-supp-del" class="ipe-btn">🗑️ 删选中</button>'
        + '      </div>'
        + '      <label class="ipe-field">补充指令 <textarea id="ipe-supplement" class="text_pole" rows="2" placeholder="这次提取额外要交代的话..."></textarea></label>'
        + '    </div>'
        + '  </div>'
        + '  <div class="ipe-section" id="ipe-section-preview">'
        + '    <div class="ipe-section-header" id="ipe-sh-preview"><span>📝 预览</span><span class="ipe-section-arrow">▼</span></div>'
        + '    <div class="ipe-section-body" id="ipe-sh-preview-body" style="display:none">'
        + '      <textarea id="ipe-preview-text" class="text_pole" rows="6" placeholder="提取结果预览..."></textarea>'
        + '      <div id="ipe-status" class="ipe-status">就绪</div>'
        + '      <div class="ipe-btn-row">'
        + '        <button type="button" id="ipe-btn-extract" class="ipe-btn">🔍 提取</button>'
        + '        <button type="button" id="ipe-btn-reroll" class="ipe-btn" disabled>🎲 重摇</button>'
        + '        <button type="button" id="ipe-btn-inject" class="ipe-btn" disabled>📥 注入</button>'
        + '        <button type="button" id="ipe-btn-reinject" class="ipe-btn">🎨 换画风</button>'
        + '        <button type="button" id="ipe-btn-stop" class="ipe-btn ipe-btn-stop" style="display:none">⏹️ 打断</button>'
        + '      </div>'
        + '    </div>'
        + '  </div>'
        + '  </div>'
        + '</div>';

    var wrap = d.createElement("div");
    wrap.innerHTML = html;
    var panel = wrap.firstElementChild;

    /* 插入到酒馆扩展设置区 */
    var container = d.getElementById("extensions_settings") || d.getElementById("extension_settings");
    if (container) container.appendChild(panel);
    else d.body.appendChild(panel);

    /* API 预设下拉填充 */
    function fillApiSelect() {
        var list = ipeGetApiProfiles(), id = ipeGetActiveApiProfile();
        ["ipe-api-profile"].forEach(function(sid){
            var sel = q("#" + sid); if (!sel) return;
            sel.innerHTML = list.map(function(pp){ return '<option value="' + pp.id + '">' + esc(pp.name) + '</option>'; }).join('');
            sel.value = id;
        });
    }

    /* API 预设增删 */
    ["ipe-api-add"].forEach(function(id){
        var el = q("#" + id); if (el) el.addEventListener("click", function(){ ipeAddApiProfile(); fillApiSelect(); });
    });
    ["ipe-api-del"].forEach(function(id){
        var el = q("#" + id); if (el) el.addEventListener("click", function(){ ipeDeleteApiProfile(); fillApiSelect(); });
    });

    /* 大抽屉折叠：点击面板标题展开/收起全部 */
    (function(){
        var toggle = q("#ipe-panel-toggle");
        var body = q("#ipe-panel-body");
        var arrow = q("#ipe-drawer-arrow");
        if (toggle && body) {
            toggle.addEventListener("click", function(){
                var open = body.style.display !== "none";
                body.style.display = open ? "none" : "";
                if (arrow) arrow.textContent = open ? "▼" : "▲";
            });
        }
    })();

    /* 各 section 折叠：点击 section-header 展开/收起对应 body */
    var shPairs = [
        ["ipe-sh-toggle", "ipe-sh-body"],
        ["ipe-sh-api", "ipe-sh-api-body"],
        ["ipe-sh-tpl", "ipe-sh-tpl-body"],
        ["ipe-sh-anchor", "ipe-sh-anchor-body"],
        ["ipe-sh-rule", "ipe-sh-rule-body"],
        ["ipe-sh-sys", "ipe-sh-sys-body"],
        ["ipe-sh-layer", "ipe-sh-layer-body"],
        ["ipe-sh-pack", "ipe-sh-pack-body"],
        ["ipe-sh-supp", "ipe-sh-supp-body"],
        ["ipe-sh-preview", "ipe-sh-preview-body"]
    ];
    shPairs.forEach(function(pair){
        var hdr = q("#" + pair[0]);
        var bdy = q("#" + pair[1]);
        if (hdr && bdy) {
            hdr.addEventListener("click", function(){
                var open = bdy.style.display !== "none";
                bdy.style.display = open ? "none" : "";
                var ar = hdr.querySelector(".ipe-section-arrow");
                if (ar) ar.textContent = open ? "▼" : "▲";
            });
        }
    });

    /* 拉取模型按钮 */
    var fetchBtn = q("#ipe-btn-fetch-models");
    if (fetchBtn) {
        fetchBtn.addEventListener("click", function(){ ipeFetchModels(); });
    }

    /* 模型下拉选择 → 同步到手动输入框 */
    var modelSel = q("#ipe-model-sel");
    if (modelSel) {
        modelSel.addEventListener("change", function(){
            var v = modelSel.value;
            var input = q("#ipe-model");
            if (v && input) {
                input.value = v;
                input.dispatchEvent(new Event("change"));
            }
        });
    }

    fillApiSelect();
    bindAll();
    ipeInstallMesButtonsObserver();
    ipeInstallMesButtons();
}

/* 分层行 HTML */
function ipeImgLayerRowsHTML(prefix, drawer) {
    var h = "";
    IPE_IMG_LAYERS.forEach(function(l){
        var label = IPE_IMG_LAYER_ICON[l] + " " + IPE_IMG_LAYER_LABEL[l];
        h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;color:#888;font-size:12px">'
           + '<span>' + label + '</span>'
           + '<span style="display:flex;gap:8px;align-items:center">'
           + '<label style="display:flex;flex-direction:row;align-items:center;gap:4px">🔒 锁 <input type="checkbox" id="' + prefix + '-lock-' + l + '"></label>'
           + '<button type="button" id="' + prefix + '-reroll-' + l + '" class="ipe-btn" style="flex:none;padding:2px 8px">只重摇这层</button>'
           + '</span></div>'
           + '<textarea id="' + prefix + '-layer-' + l + '" class="text_pole" rows="2"></textarea>';
    });
    return h;
}

/* ============================================================
   初始化
   ============================================================ */
function init() {
    if (initialized) return;
    try {
        loadSettings();
        createUI();
        initialized = true;
        console.log("[IPE] ✓ Image Generator v" + IPE_VERSION + " 已加载");
    } catch(e) { console.error("[IPE] 初始化失败:", e); }
}

function waitAndInit() {
    if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) {
        setTimeout(waitAndInit, 300); return;
    }
    try {
        var c = SillyTavern.getContext();
        if (c.eventSource && c.event_types && c.event_types.APP_READY) {
            c.eventSource.on(c.event_types.APP_READY, function(){ setTimeout(init, 100); });
        } else { setTimeout(init, 2000); }
    } catch(e) { setTimeout(init, 2000); }
}

waitAndInit();
