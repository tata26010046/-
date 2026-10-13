// レシートOCR（Tesseract.js・端末内で処理。初回のみ日本語データ約15MBをダウンロードします）
let workerP = null;
let progressCb = null;

function getWorker() {
  if (!window.Tesseract) return Promise.reject(new Error("OCRライブラリを読み込めませんでした"));
  if (!workerP) {
    workerP = window.Tesseract.createWorker("jpn", 1, {
      logger: m => {
        if (!progressCb) return;
        if (m.status === "recognizing text") progressCb("読み取り中", m.progress);
        else if (/loading|initializ/.test(m.status)) progressCb("文字データを準備中（初回のみ時間がかかります）", m.progress || 0);
      }
    }).then(async w => {
      await w.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: "6" });
      return w;
    }).catch(e => { workerP = null; throw e; });
  }
  return workerP;
}

// 白黒化・コントラスト強調・拡大で精度を上げる
async function preprocess(blob) {
  const bmp = await createImageBitmap(blob);
  const target = Math.min(2000, Math.max(1400, bmp.width));
  const k = target / bmp.width;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height); const d = im.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const y = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114; d[i] = y; sum += y; }
  const avg = sum / (d.length / 4);
  for (let i = 0; i < d.length; i += 4) {
    let y = (d[i] - avg) * 1.6 + 150;
    y = y < 0 ? 0 : y > 255 ? 255 : y;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  g.putImageData(im, 0, 0);
  return c;
}

const z2h = s => s
  .replace(/[０-９Ａ-Ｚａ-ｚ％＆（）．，／：＊＠]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[￥]/g, "¥").replace(/[　]/g, " ")
  .replace(/[－−‐–](?=\s*[¥\\]?\s*\d)/g, "-");

// 日本語の文字間に入る余計な空白を詰める
const tidy = s => s.replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, "$1").replace(/\s{2,}/g, " ").trim();

const SKIP = /小計|合計|合 計|お?預り|預かり|お?釣|おつり|対象|税率|内税|内消費税|消費税等|税込|ポイント|ﾎﾟｲﾝﾄ|現金|クレジット|カード|電子マネー|交通系|PayPay|QUICPay|iD|残高|点数|買上|お買上|領収|登録番号|TEL|電話|レジ|担当|責任者|伝票|No\.|釣銭|合計点|値引前|会員|^\s*#/i;

const GENRE_WORDS = [
  ["日用品", /ティッシュ|トイレ|洗剤|シャンプー|リンス|ラップ|ゴミ袋|ごみ袋|歯ブラシ|歯磨|電池|マスク|キッチンペーパー|柔軟剤|ソープ|スポンジ|ホイル|タオル|綿棒|洗濯/],
  ["医療", /薬|錠|絆創膏|目薬|湿布|ドリンク剤|サプリ/],
  ["外食", /セット|定食|ランチ|ディナー|テイクアウト|店内/],
  ["交通", /乗車|運賃|切符|駐車|ガソリン|レギュラー|ハイオク/],
  ["衣服", /シャツ|パンツ|靴下|ソックス|下着|ジャケット|スカート/],
  ["食費", /肉|豚|牛|鶏|魚|鮭|まぐろ|野菜|卵|たまご|玉子|牛乳|乳|パン|米|豆腐|納豆|ヨーグルト|チーズ|キャベツ|玉ねぎ|たまねぎ|人参|にんじん|じゃが|トマト|きゅうり|もやし|バナナ|りんご|醤油|しょうゆ|味噌|みそ|油|砂糖|塩|麺|うどん|そば|パスタ|冷凍|惣菜|弁当|おにぎり|茶|水|ジュース|コーヒー|菓子|チョコ|ポテト|アイス|ハム|ソーセージ|ウインナー|ベーコン|カレー|ねぎ|白菜|大根|きのこ|しめじ|えのき|果|ドレッシング|マヨ|ケチャップ|ソース/]
];

function guessGenre(name, cats) {
  for (const [g, re] of GENRE_WORDS) if (cats.includes(g) && re.test(name)) return g;
  return cats.includes("食費") ? "食費" : (cats.includes("その他") ? "その他" : cats[0]);
}

export function parseReceipt(text, cats) {
  const lines = text.split(/\n/).map(l => tidy(z2h(l))).filter(Boolean);
  const out = { store: "", date: null, items: [], total: null, raw: lines.join("\n") };

  // 日付
  for (const l of lines) {
    let m = l.match(/(20\d{2})\s*[年\/.\-]\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})/);
    if (!m) { const r = l.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/); if (r) m = [0, 2018 + Number(r[1]), r[2], r[3]]; }
    if (m) { const mo = Number(m[2]), da = Number(m[3]); if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) { out.date = `${m[1]}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`; break; } }
  }
  // 店名：最初の数行で数字が少なく2文字以上の行
  for (const l of lines.slice(0, 6)) {
    if (/領収|レシート|ようこそ|ありがとう|TEL|電話|\d{2,}-\d{2,}/.test(l)) continue;
    const digits = (l.match(/\d/g) || []).length;
    if (l.length >= 2 && digits <= 2) { out.store = l.replace(/[*＊]/g, "").trim(); break; }
  }

  const priceRe = /^(.*?)\s*[¥\\]?\s*(-?\d{1,3}(?:,\d{3})+|-?\d{1,6})\s*円?\s*(?:[外内軽※*Ａ-ＺA-Z]{1,2})?\s*$/;
  const taxCands = [];
  let pendingQty = null;
  for (const l of lines) {
    // 「2個 X 単98」のような数量行
    const q = l.match(/(\d+)\s*[個点コ]\s*[xX×ｘ@＠]\s*(?:単)?\s*[¥\\]?\s*(\d+)/);
    if (q && !/[^\d\s個点コxX×ｘ@＠単¥\\]{3,}/.test(l.replace(q[0], ""))) { pendingQty = Number(q[1]); continue; }

    if (/\d{1,2}:\d{2}|20\d{2}\s*[年\/.\-]\s*\d{1,2}|令和/.test(l)) continue;  // 日時の行
    const m = l.match(priceRe);
    if (!m) continue;
    let name = m[1].replace(/[¥\\]$/, "").replace(/^[\d\s.*＊]+/, "").trim();
    const price = Number(m[2].replace(/,/g, ""));
    if (/合計/.test(l) && !/小計|点/.test(l)) { if (price > 0) out.total = price; continue; }
    if (/消費税|外税/.test(l) && !/内/.test(l)) { if (price > 0) taxCands.push(price); continue; }
    if (SKIP.test(l)) continue;
    if (!name || name.length < 2 || !/[^\d\s\-.,]/.test(name)) continue;
    if (Math.abs(price) > 200000 || price === 0) continue;
    const isDisc = /値引|割引|引き|クーポン|OFF|off/.test(name) || price < 0;
    const qtyIn = name.match(/(\d+)\s*[個点]$/);
    const qty = pendingQty || (qtyIn ? Number(qtyIn[1]) : 1);
    pendingQty = null;
    out.items.push({ name, genre: isDisc ? (out.items.at(-1)?.genre || guessGenre(name, cats)) : guessGenre(name, cats), qty, price: isDisc ? -Math.abs(price) : price });
  }
  // 外税：合計との差が税額と一致すれば1行追加
  const sum = out.items.reduce((a, it) => a + it.price, 0);
  if (out.total != null) {
    const diff = out.total - sum;
    const hit = taxCands.find(t => Math.abs(t - diff) <= 1) ?? (taxCands.length > 1 && Math.abs(taxCands.reduce((a, b) => a + b, 0) - diff) <= 1 ? taxCands.reduce((a, b) => a + b, 0) : null);
    if (hit) out.items.push({ name: "消費税", genre: cats.includes("その他") ? "その他" : cats[0], qty: 1, price: hit });
  }
  return out;
}

export async function ocrReceipt(blob, cats, onProgress) {
  progressCb = onProgress;
  try {
    const w = await getWorker();
    const img = await preprocess(blob);
    const { data } = await w.recognize(img);
    return parseReceipt(data.text || "", cats);
  } finally { progressCb = null; }
}
