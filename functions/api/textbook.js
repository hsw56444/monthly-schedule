// 교재비 불러오기 (간편장부 → [교재비 불러오기])
// 미래엔수학·미래엔영어 가맹점 사이트에 로그인해 고른 달의 결제(수학)·주문(영어) 날짜·금액을 읽어 준다.
// 두 사이트 모두 브라우저에서 바로 부를 수 없어서(수학은 Origin 검사, 영어는 쿠키 로그인) 여기서 대신 접속한다.
// 아이디·비밀번호는 요청에 실려 와서 이번 접속에만 쓰고 어디에도 저장하지 않는다.
//
// POST { site: 'math' | 'eng', id, pw, year: 2026, months: [8, 9, 10] }
// → { ok: true, rows: [{ ym, date, amount, ref, cancel }], months: { '2026-10': 건수 } }
//   수학: 그 '주문월'의 본사입금 결제내역(결제일·결제금액). 결제일은 다음 달인 경우가 많다
//   영어: 그 달의 주문내역(주문일·주문금액). 주문취소 줄은 cancel: true

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const pad = (n) => String(n).padStart(2, '0');

class UserError extends Error {}

// ─── 미래엔수학 (api.miraenmath.co.kr, JSON) ───
async function fetchMath(id, pw, year, months) {
    const API = 'https://api.miraenmath.co.kr/api/cms/v1';
    const O = { Origin: 'https://class.miraenmath.co.kr', Referer: 'https://class.miraenmath.co.kr/', 'User-Agent': UA };
    const lr = await fetch(API + '/login', {
        method: 'POST',
        headers: { ...O, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ id, password: pw }).toString(),
    });
    const lj = await lr.json().catch(() => ({}));
    const token = lj.data && lj.data.token;
    if (!token) throw new UserError('미래엔수학 로그인 실패: ' + ((lj.result && lj.result.message) || `응답 ${lr.status}`));
    const H = { ...O, Authorization: 'Bearer ' + token };
    const me = await (await fetch(API + '/login/me', { method: 'POST', headers: H })).json().catch(() => ({}));
    const uid = me.data && me.data.id;
    if (!uid) throw new UserError('미래엔수학 로그인 정보를 읽지 못했어요.');
    const rows = [], counts = {};
    await Promise.all(months.map(async (m) => {
        const ym = `${year}-${pad(m)}`;
        const r = await fetch(`${API}/order/classes/${encodeURIComponent(uid)}/head-deposits/vaccount?year=${year}&month=${m}&highClssAt=N`, { headers: H });
        const j = await r.json().catch(() => ({}));
        if (!j.result || j.result.code !== 'success') throw new Error(`미래엔수학 ${m}월 결제내역 응답 이상 (${r.status})`);
        const list = Array.isArray(j.data) ? j.data : [];
        counts[ym] = list.length;
        list.forEach((d) => {
            const date = String(d.rcpmnyDe || d.regDt || '').slice(0, 10);
            const amount = Number(d.rcpmnyAmount) || 0;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) return;
            rows.push({ ym, date, amount, ref: `M${year}${pad(m)}-${date}-${amount}`, cancel: false });
        });
    }));
    return { rows, counts };
}

// ─── 미래엔영어 (www.miraenenglish.co.kr, 쿠키 로그인 + 표 HTML) ───
async function fetchEng(id, pw, year, months) {
    const B = 'https://www.miraenenglish.co.kr';
    const jar = new Map();
    const keep = (r) => {
        const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
        list.forEach((c) => {
            const kv = c.split(';')[0], i = kv.indexOf('=');
            if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
        });
    };
    const go = async (path, opt = {}) => {
        const r = await fetch(B + path, {
            ...opt,
            redirect: 'manual',
            headers: { 'User-Agent': UA, Referer: B + '/center/login', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opt.headers || {}) },
        });
        keep(r);
        return r.text();
    };
    await go('/center/login');
    const t = await go('/common/program/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ f_next: '', f_web_id: id, f_web_pw: pw }).toString(),
    });
    if (!jar.has('web_id') && !/location\.href/.test(t)) {
        const msg = (t.match(/alert\("([^"]+)"\)/) || [])[1];
        throw new UserError('미래엔영어 로그인 실패: ' + (msg ? msg.trim() : '아이디·비밀번호를 확인해주세요.'));
    }
    const cell = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const rows = [], counts = {};
    for (const m of months) {
        const ym = `${year}-${pad(m)}`;
        let n = 0;
        for (let page = 1; page <= 10; page++) {
            const html = await go(`/center/order/orderlist.data.cshtml?x=y&f_page=${page}&f_cnt=&f_order=&f_sort=&f_year=${year}&f_month=${pad(m)}&rnd=${Math.random()}`);
            if (/center\/login|로그인/.test(html) && !/<tr/i.test(html)) throw new UserError('미래엔영어 로그인이 풀렸어요. 다시 시도해주세요.');
            const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
            trs.forEach((tr) => {
                const tds = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(cell);
                if (tds.length < 6 || !/^\d{4}-\d{2}-\d{2}$/.test(tds[0])) return;
                const amount = Number((tds[5] || '').replace(/[^\d]/g, '')) || 0;
                const ref = ((tds[1] || '').match(/(\d{6})-(\d{8})/) || [])[0] || '';
                rows.push({ ym, date: tds[0], amount, ref, cancel: /취소/.test(tds[tds.length - 1] || '') });
                n++;
            });
            // doSetPage(전체 건수, 한 쪽 건수, 쪽)
            const pg = html.match(/doSetPage\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            if (!pg || Number(pg[3]) * Number(pg[2]) >= Number(pg[1])) break;
        }
        counts[ym] = n;
    }
    return { rows, counts };
}

export async function onRequestPost({ request }) {
    let q;
    try { q = await request.json(); } catch (e) { return json({ ok: false, error: '요청 형식이 잘못됐어요.' }, 400); }
    const site = q.site, id = String(q.id || '').trim(), pw = String(q.pw || '');
    const year = Number(q.year);
    const months = [...new Set((q.months || []).map(Number))].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
    if (!['math', 'eng'].includes(site)) return json({ ok: false, error: '사이트를 골라주세요.' }, 400);
    if (!id || !pw) return json({ ok: false, error: '아이디·비밀번호를 입력해주세요.' }, 400);
    if (!(year >= 2020 && year <= 2100) || !months.length) return json({ ok: false, error: '연도·월을 골라주세요.' }, 400);
    try {
        const out = site === 'math' ? await fetchMath(id, pw, year, months) : await fetchEng(id, pw, year, months);
        out.rows.sort((a, b) => a.date.localeCompare(b.date));
        return json({ ok: true, ...out });
    } catch (e) {
        return json({ ok: false, error: e instanceof UserError ? e.message : `사이트에서 읽지 못했어요: ${e.message}` }, e instanceof UserError ? 401 : 502);
    }
}

export async function onRequestGet() {
    return json({ ok: true, hint: 'POST { site, id, pw, year, months }' });
}
