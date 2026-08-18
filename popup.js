// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * popup.js — 設定画面の組み立てと保存
 *
 * 【どこから呼ばれるか】
 *   popup.html の <script src="popup.js" defer> から、shared/schema.js → common.js の後に
 *   読み込まれ、その場で自動実行される。誰かが呼び出す関数は持たない。
 *   この画面はツールバーの小窓としても、オプションページの独立タブとしても開かれるが、
 *   コードはまったく同じものが動く。
 *
 * 【何をするファイルか】
 *   popup.html には文言も対応関係も書かれておらず、data 属性でキー名が宣言されているだけである。
 *   このファイルはそれを読み取って、
 *     1. 翻訳文言を流し込み
 *     2. 入力欄と設定キーを結び付け
 *     3. サイト切り替えタブとヘルプ吹き出しを生成し
 *     4. 値の変更を storage へ保存する
 *   という組み立て作業を行う。対応表は popup.html の冒頭コメントにまとまっている。
 *
 * 【保存形式】
 *   settings = { common: {...}, youtube: {...}, twitch: {...}, twitcasting: {...} }
 *   ui       = { site: 手動で選んだタブ, seen: 直近に見ていたサイト }
 *
 *   保存するのは「利用者が実際に触った値」だけで、既定値は一切書き込まない。
 *   この方針のおかげで、リセットは該当スコープを空オブジェクトにするだけで済み、
 *   また将来ここで既定値を変更したときに、触っていない項目へ自動で反映される利点もある。
 *
 * 【デバッグ】
 *   URL に ?locale=en などを付けて開くと、表示言語を強制的に差し替えられる。
 * ================================================================================================ */
(async () => {
    'use strict';

    // common.js が用意した窓口から、このファイルで使うものだけを取り出す
    const { api, store, msg, log, KEYS, SITES, siteOf, settingsOf, fix } = globalThis.SLPSTRM ?? {};

    // 読み込み順が壊れて設計図が合流していない場合は、例外を投げずに静かに終了する
    if (!KEYS || !SITES) { console.warn('[slipstreamlive] shared/schema.js が読み込まれていません'); return; }

    const COMMIT_MS = 400;              // 数値入力を「打ち終わった」とみなすまでの待ち時間（ミリ秒）。デバウンスと呼ばれる手法
    const PAD       = 8;                // ヘルプ吹き出しと画面端の間に空ける最小の余白（ピクセル）
    const TIP_DX    = 12;               // スライダーの吹き出しをカーソルの右へずらす量（ピクセル）
    const TIP_DY    = 18;               // スライダーの吹き出しをカーソルの下へずらす量（ピクセル）
    const sites     = Object.keys(SITES); // サポート対象サイトの識別子の配列（['youtube', 'twitch', 'twitcasting']）
    const rows      = [...document.querySelectorAll('.row')]; // 設定行（.row）の一覧。有効・無効の切り替えをまとめて行うために先に集めておく
    const tabs      = new Map();        // サイト識別子 → タブボタン要素 の対応表（buildTabs() が埋める）

    // 特定のサイトでだけ見せる要素の一覧（注釈と、そのサイトにしか無い設定のグループ）。
    // #scopes に限っているのは、<html> 自身も目印として data-site を持たされるため
    const scoped    = [...document.querySelectorAll('#scopes [data-site]')];

    // 設定キーに紐づく入力要素の一覧。
    // data-key の綴り間違いを黙って無視すると原因不明の不具合になるため、警告を出して除外する
    const inputs = [...document.querySelectorAll('[data-key]')].filter((input) => {
        if (KEYS[input.dataset.key]) return true;
        log.warn('unknown data-key', input.dataset.key);
        return false;
    });

    let current = sites[0];             // 現在表示しているサイトタブの識別子
    let data    = {};                   // storage の settings のキャッシュ（画面上の操作はまずここへ反映してから保存する）
    let ui      = {};                   // storage の ui のキャッシュ（どのタブを選ぶかの判断材料）

    /* ============================================================================================
       表示文言（多言語対応）
       ============================================================================================ */

    let strings = null;                     // ?locale= が指定されたときだけ読み込む辞書。通常は null のまま
    let locale  = api.i18n.getUILanguage(); // 実際に適用している UI 言語コード（<html lang> にも設定する）

    /**
     * メッセージキーから翻訳文字列を取り出す。
     * デバッグ用の辞書が読み込まれていればそちらを優先し、無ければ通常の i18n を使う。
     *
     * @param {string} key - _locales のメッセージキー
     * @returns {string} 翻訳文字列
     */
    const t = (key) => strings?.[key]?.message ?? msg(key);

    /**
     * URL に ?locale=xx が付いていれば、その言語の辞書を直接読み込む（開発時の確認用）。
     * ブラウザの言語設定を変えずに全言語の見た目を検証できるようにするための仕組み。
     *
     * @returns {Promise<void>}
     */
    async function loadLocale() {
        const name = new URLSearchParams(location.search).get('locale');
        if (!name || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) return;

        try {
            const res = await fetch(api.runtime.getURL(`_locales/${name}/messages.json`));
            if (!res.ok) return;        // 存在しない言語コードなら黙って既定言語のまま進む

            strings = await res.json();
            locale = name;
        } catch (error) { log.warn('loadLocale', error); }
    }

    /**
     * data-msg / data-title / data-hint の各属性を走査して、翻訳文言や範囲表示を流し込む。
     * 文言は途中で変わらないため、起動時に一度だけ実行すればよい。
     *
     * @returns {void}
     */
    function translate() {
        document.documentElement.lang = locale; // 読み上げソフトなどが正しい言語で読めるようにする
        document.title = t('appName');
        document.getElementById('version').textContent = `v${api.runtime.getManifest().version}`;

        for (const node of document.querySelectorAll('[data-msg]')) node.textContent = t(node.dataset.msg);
        for (const node of document.querySelectorAll('[data-title]')) node.title = t(node.dataset.title);

        // data-href は「リンク先そのものを翻訳する」ための属性。
        // 取扱説明書のように言語別のページがある場合、URL を _locales に持たせておけば分岐が要らない
        for (const node of document.querySelectorAll('[data-href]')) node.href = t(node.dataset.href);

        // 入力できる範囲の目安（例: 「1.05 ~ 4.00」）を生成する。
        // 刻み幅が 1 以上（duckVolume の 5 など）なら整数表示のほうが読みやすいので小数桁を 0 にする
        for (const node of document.querySelectorAll('[data-hint]')) {
            const range = KEYS[node.dataset.hint]?.range;
            if (!range) { log.warn('data-hint に数値設定でないキーが指定されています', node.dataset.hint); continue; }

            const [min, max, step] = range;
            const digits = step >= 1 ? 0 : 2; // 表示する小数桁数
            node.textContent = `${min.toFixed(digits)} ~ ${max.toFixed(digits)}`;
        }
    }

    /* ============================================================================================
       描画と保存
       ============================================================================================ */

    /**
     * 空白区切りの文字列を配列へ変換する（例: 'enabled floor duck' → ['enabled', 'floor', 'duck']）。
     * data-needs / data-not / data-labels の値を読むために使う。空文字なら空配列になる。
     *
     * @param {string|undefined} value - 空白区切りの設定キー一覧
     * @returns {string[]} 設定キーの配列
     */
    const list = (value) => (value ?? '').split(' ').filter(Boolean);

    /**
     * 保存データから実効設定を計算し直し、画面全体を最新の状態へ更新する。
     * タブ切り替え・値の変更・リセット・他ウィンドウでの変更、すべてこの関数を通る。
     *
     * @returns {void}
     */
    function render() {
        const settings = settingsOf(data, current); // 表示中サイトの実効設定（既定値で埋まった完全な形）

        document.documentElement.dataset.site = current; // CSS がサイト別アクセント色を切り替える目印
        document.getElementById('reset-site').textContent = `${t('reset')} · ${SITES[current].label}`;

        for (const [site, tab] of tabs) tab.ariaSelected = String(site === current);

        // 表示中のタブと data-site が一致する要素だけを見せる
        for (const node of scoped) node.hidden = node.dataset.site !== current;

        for (const input of inputs) {
            const value = settings[input.dataset.key];
            if (input.type === 'checkbox') input.checked = value;
            // 入力中の欄まで書き換えると、打っている途中の文字が消えてしまうので触らない
            else if (input !== document.activeElement) input.value = String(value);
        }

        // 行の依存関係を解決する。
        //   有効 = data-needs に挙げた設定がすべて ON、かつ data-not に挙げた設定が 1 つも ON でない
        for (const row of rows) {
            const input = row.querySelector('[data-key]');
            if (!input) continue;       // 入力欄を持たない行（注釈など）は対象外

            const on = list(row.dataset.needs).every((key) => settings[key])
                && !list(row.dataset.not).some((key) => settings[key]);

            input.disabled = !on;                  // 実際に操作できなくする
            row.classList.toggle('disabled', !on); // 見た目も薄くする（CSS の .row.disabled）
        }
    }

    /**
     * settings の 1 バケット（保存先の区画）を丸ごと差し替えて保存し、画面を描き直す。
     *
     * オブジェクトを書き換えずに毎回新しく作り直しているのは、
     * 元のデータを直接いじらないことで、値の流れを追いやすく保つため。
     *
     * @param {string} scope  - 保存先バケット名（'common' またはサイト識別子）
     * @param {Object} values - そのバケットへ入れる値
     * @returns {void}
     */
    function commit(scope, values) {
        data = { ...data, [scope]: values };
        store.set('settings', data);
        render();
    }

    /**
     * 設定値を 1 つ保存する。
     * 共通設定なら 'common' へ、サイト別設定なら指定サイトのバケットへ書き込む。
     *
     * @param {string} key    - 設定キー
     * @param {any}    value  - 保存する値
     * @param {string} [site] - 保存先サイト識別子（既定は表示中のタブ）
     * @returns {void}
     */
    function save(key, value, site = current) {
        const scope = KEYS[key].scope === 'common' ? 'common' : site; // 保存先のバケット名
        commit(scope, { ...data[scope], [key]: value });
    }

    /**
     * 指定した範囲の設定を消して、すべて既定値へ戻す。
     * 保存しているのは「触った値」だけなので、空オブジェクトにすれば
     * settingsOf() が自動的に既定値で埋め直してくれる。
     *
     * @param {string} scope - 'common' なら共通設定、それ以外なら表示中のサイト
     * @returns {void}
     */
    const reset = (scope) => commit(scope === 'common' ? 'common' : current, {});

    /* ============================================================================================
       入力欄のイベント接続
       --------------------------------------------------------------------------------------------
       入力欄は 3 種類あり、値が確定するタイミングが違うので接続の仕方も分けている。

         チェックボックス … 取りうる値が 2 つしかない。変更されたらそのまま保存する
         段階スライダー   … 取りうる値がもともと刻み幅に乗っている。動かしたその場で保存する
         数値入力         … 打ちかけの状態が存在する。唯一 2 段構えの保存が必要（wireNumber 参照）
       ============================================================================================ */

    /**
     * 入力欄の文字列を数値化し、許容範囲に収まっているかを判定する。
     * 刻み幅による丸めはここでは行わない（打っている最中に値が飛ぶと入力しづらいため）。
     *
     * @param {HTMLInputElement} input - 対象の入力要素
     * @param {number[]} range - [min, max, step]（step は使わないので分割代入では受け取らない）
     * @returns {number|null} 範囲内の数値。範囲外や解釈不能なら null
     */
    function parse(input, [min, max]) {
        const num = Number.parseFloat(input.value);
        return Number.isFinite(num) && num >= min && num <= max ? num : null;
    }

    /**
     * チェックボックスを接続する。打ちかけの状態が無いので、変更されたらそのまま保存するだけでよい。
     *
     * @param {HTMLInputElement} input - 対象の入力要素
     * @param {string}           key   - この入力欄が対応する設定キー
     * @returns {void}
     */
    function wireSwitch(input, key) {
        input.addEventListener('change', () => save(key, input.checked));
    }

    /**
     * 段階スライダーを接続する。
     * 取りうる値がもともと刻み幅に乗っているため、丸めも打ちかけの判定も要らない。
     * つまみを動かしたその場で保存し、同時に吹き出しの表示も更新する。
     *
     * @param {HTMLInputElement} input - 対象の入力要素
     * @param {string}           key   - この入力欄が対応する設定キー
     * @returns {void}
     */
    function wireSlider(input, key) {
        input.addEventListener('input', () => {
            Tip.follow(input);
            save(key, fix(current, key, input.value));
        });
        wireTip(input);
    }

    /**
     * 自由に打ち込める数値入力を接続する。ここだけ 2 段構えの保存を用意している。
     *
     *   input イベント  … 打つたびに発火。範囲内の値になった時点で COMMIT_MS 待ってから先行保存する。
     *                     小窓は他の場所をクリックしただけで閉じてしまうため、
     *                     確定操作を待っていると入力した値が失われることがあるための保険。
     *   change イベント … 確定時（Enter やフォーカス移動）に発火。刻み幅に丸めて保存する。
     *                     数値として解釈できない状態なら、確定前の設定値へ戻す。
     *
     * @param {HTMLInputElement} input - 対象の入力要素
     * @param {string}           key   - この入力欄が対応する設定キー
     * @param {number[]}         range - [min, max, step]
     * @returns {void}
     */
    function wireNumber(input, key, range) {
        let timer = 0;                              // 先行保存のタイマー ID

        input.addEventListener('input', () => {
            clearTimeout(timer);
            if (parse(input, range) === null) return; // 打ちかけの不正な値は確定を待つ

            // 保存先サイトは「入力した時点」のものを閉じ込める。current を後から読むと、
            // 待っているあいだにタブを切り替えられたとき別サイトへ書き込んでしまう
            const site = current;
            timer = setTimeout(() => save(key, fix(site, key, input.value), site), COMMIT_MS);
        });

        input.addEventListener('change', () => {
            clearTimeout(timer);        // 先行保存の予約は不要になるので取り消す

            const site = current;
            if (!Number.isFinite(Number.parseFloat(input.value))) {
                input.value = String(settingsOf(data, site)[key]);
                return;
            }

            const value = fix(site, key, input.value); // 刻み幅で丸め、範囲に収めた値
            input.value = String(value);               // 丸めた結果を画面へも反映する
            save(key, value, site);
        });
    }

    /**
     * 入力欄を種類に応じた接続処理へ振り分ける。
     *
     * @param {HTMLInputElement} input - 対象の入力要素
     * @returns {void}
     */
    function wireInput(input) {
        const key = input.dataset.key;  // この入力欄が対応する設定キー
        if (input.type === 'checkbox') return wireSwitch(input, key);

        const { range } = KEYS[key];                // [min, max, step]
        [input.min, input.max, input.step] = range; // ブラウザ標準の入力補助（スピナーや検証）を効かせる

        return input.type === 'range' ? wireSlider(input, key) : wireNumber(input, key, range);
    }

    /* ============================================================================================
       サイトタブとヘルプ UI の構築
       ============================================================================================ */

    /**
     * サイト切り替えタブを SITES の定義から生成する。
     * HTML に直接書かずここで作るのは、対応サイトを追加したときに
     * shared/schema.js の SITES へ 1 行足すだけで済むようにするため。
     *
     * @returns {void}
     */
    function buildTabs() {
        const bar = document.getElementById('tabs');

        for (const site of sites) {
            const tab = document.createElement('button');
            tab.type        = 'button';
            tab.className   = 'tab';
            tab.role        = 'tab';
            tab.textContent = SITES[site].label;

            tab.addEventListener('click', () => {
                current = site;
                ui = { ...ui, site };   // 次回起動時の候補として、手動で選んだことを記録する
                store.set('ui', ui);
                render();
            });

            bar.append(tab);
            tabs.set(site, tab);
        }
    }

    /**
     * ? ボタンを押したときに開くヘルプ吹き出しを用意する。
     *
     * popover 属性はブラウザ標準の機能で、最前面への表示や外側クリックでの自動的な
     * 閉じる動作を自前で実装せずに済ませられる。ただし表示位置だけは自分で決める必要があるため、
     * 開いた直後に実寸を測って、画面からはみ出さないようクランプしている。
     *
     * @returns {void}
     */
    function buildHelp() {
        for (const icon of document.querySelectorAll('[data-help]')) {
            const bubble = document.createElement('div');
            bubble.className   = 'help';
            bubble.popover     = 'auto'; // 'auto' は「外側をクリックすると閉じる」動作
            bubble.textContent = t(icon.dataset.help);
            document.body.append(bubble);

            icon.addEventListener('click', () => {
                bubble.style.left = bubble.style.top = '-9999px';       // 位置計算前の一瞬のちらつきを防ぐ
                if (!bubble.togglePopover()) return; // 閉じた場合は位置計算をしない

                // アイコンの右下を基準に置き、画面の外へはみ出さないよう左上端も右下端も制限する
                const box = bubble.getBoundingClientRect(); // 吹き出しの実寸
                const at  = icon.getBoundingClientRect();   // アイコンの位置

                bubble.style.left = `${Math.max(PAD, Math.min(at.right + PAD, innerWidth - box.width - PAD))}px`;
                bubble.style.top  = `${Math.max(PAD, Math.min(at.bottom + PAD, innerHeight - box.height - PAD))}px`;
            });
        }
    }

    /* ============================================================================================
       段階スライダーの吹き出し
       --------------------------------------------------------------------------------------------
       段階スライダー（type="range"）は、つまみの位置だけでは「今どの設定なのか」が分からない。
       そこでマウスを乗せている間だけ、カーソルの近くへ段階名（オフ / 標準 / 積極的）を出す。

       ヘルプの吹き出しと違って popover は使わない。popover は「開いたら操作するもの」であり、
       外側クリックで閉じる挙動やフォーカスの移動がホバー表示とは噛み合わないため、
       単純な position: fixed の <div> を出し入れするほうが素直に振る舞う。
       ============================================================================================ */

    const Tip = (() => {
        const node = document.createElement('div');
        node.className = 'tip';
        node.hidden    = true;
        document.body.append(node);

        let x = 0;                      // 直近に観測したカーソルの横位置（ビューポート座標）
        let y = 0;                      // 同じく縦位置

        /**
         * 記録してあるカーソル位置を基準に吹き出しを置き直す。
         * カーソルに重ならないよう少しずらし、画面の外へはみ出さないよう両端で制限する。
         *
         * @returns {void}
         */
        function place() {
            const box = node.getBoundingClientRect(); // 吹き出しの実寸（文言の長さで変わる）

            node.style.left = `${Math.max(PAD, Math.min(x + TIP_DX, innerWidth - box.width - PAD))}px`;
            node.style.top  = `${Math.max(PAD, Math.min(y + TIP_DY, innerHeight - box.height - PAD))}px`;
        }

        return {
            /**
             * カーソル位置を記録する。表示中ならそのまま追従させる。
             *
             * @param {PointerEvent} event - pointerenter / pointermove のイベント
             * @returns {void}
             */
            move(event) {
                x = event.clientX;
                y = event.clientY;
                if (!node.hidden) place();
            },

            /**
             * スライダーの現在値に対応する段階名を表示する。
             * 目盛り名が用意されていない値なら、何も出さずに引っ込める。
             *
             * @param {HTMLInputElement} input - 対象のスライダー
             * @returns {void}
             */
            follow(input) {
                const keys = list(input.dataset.labels);        // 目盛りに対応する i18n キー（最小値から順）
                const [min, , step] = KEYS[input.dataset.key].range;
                const key = keys[Math.round((Number.parseFloat(input.value) - min) / step)];

                if (!key) return this.hide();

                node.textContent = t(key);
                node.hidden      = false;
                place();
            },

            /**
             * 吹き出しを隠す。
             *
             * @returns {void}
             */
            hide() { node.hidden = true; },
        };
    })();

    /**
     * スライダーへ吹き出しの表示・追従・消去を接続する。
     *
     * 無効化された入力要素はポインタイベントを受け取らないため、
     * 「前提条件を満たしていない行では出さない」は自動的に満たされる。
     *
     * @param {HTMLInputElement} input - 対象のスライダー
     * @returns {void}
     */
    function wireTip(input) {
        input.addEventListener('pointerenter', (event) => { Tip.move(event); Tip.follow(input); });
        input.addEventListener('pointermove', (event) => Tip.move(event));
        input.addEventListener('pointerleave', () => Tip.hide());
        input.addEventListener('pointercancel', () => Tip.hide());  // ドラッグが横取りされた場合の保険
        input.addEventListener('blur', () => Tip.hide());
    }

    /**
     * 起動時にどのサイトタブを選ぶべきかを判断する。
     * 「今見ているページの設定をすぐ変えたい」という使い方が最も多いため、
     * 開いているタブの URL を最優先とし、取れない場合に順次あとの候補へ落ちる。
     *
     *   優先順位: アクティブタブの URL > 直近の閲覧サイト (ui.seen) > 前回の手動選択 (ui.site) > 先頭
     *
     * ui.seen は content.js が閲覧中に記録しているもので、
     * activeTab 権限が使えない状況（オプションページとして開いた場合など）の受け皿になる。
     *
     * @returns {Promise<string>} 選択すべきサイト識別子
     */
    async function detect() {
        try {
            const [tab] = await api.tabs.query({ active: true, currentWindow: true });
            const site = tab?.url ? siteOf(new URL(tab.url).hostname) : null;
            if (site) return site;
        } catch (error) { log.say('tabs.query', error); } // 権限不足などなら静かに次の候補へ

        if (sites.includes(ui.seen)) return ui.seen;
        if (sites.includes(ui.site)) return ui.site;
        return sites[0];
    }

    /* ============================================================================================
       起動シーケンス
       --------------------------------------------------------------------------------------------
       文言を入れる → 部品を組み立てる → 保存値を読む → 描画する、の順に進める。
       storage の読み出しは非同期なので、await で確実に揃ってから render() を呼ぶ。
       ============================================================================================ */
    await loadLocale();
    translate();

    for (const input of inputs) wireInput(input);
    for (const button of document.querySelectorAll('[data-reset]')) {
        button.addEventListener('click', () => reset(button.dataset.reset));
    }

    buildTabs();
    buildHelp();

    ui      = await store.get('ui');
    data    = await store.get('settings');
    current = await detect();
    render();

    // 他のウィンドウで開いた設定画面や content.js による変更を、この画面へもリアルタイムに反映する
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
            data = changes.settings.newValue ?? {};
            render();
        }
    });
})();
