// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * popup.js — ツールバーのアイコンを押すと開く「設定画面」の処理
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   popup.html に並んだスイッチ・数値入力・スライダーを動かし、
 *   変更内容を保存領域へ書き込むところまでを担当します。
 *   同じ画面は、新しいタブで開く「オプション」ページとしても使われます。
 *
 * ■ 設計の考え方：HTML の data-* 属性が「設定」を持つ
 *   このファイルには「speedupRate は数値入力」といった個別の記述がありません。
 *   代わりに HTML 側の data-* 属性を読み取り、それに従って動きます。
 *   項目を増やしたいときは popup.html と shared/schema.js を直すだけで済みます。
 *
 *   使っている data-* 属性の一覧：
 *     data-key    … この入力欄が担当する設定キー（例: data-key="speedupRate"）
 *     data-msg    … 要素のテキストに入れる、多言語ファイルのキー
 *     data-title  … マウスを乗せたとき出るツールチップの文言キー
 *     data-href   … リンク先 URL の文言キー（言語ごとにリンク先が違うため）
 *     data-hint   … 「0.10 ~ 100.00」のような入力可能範囲の表示先
 *     data-help   … 「?」ボタンを押したとき出る説明文のキー
 *     data-labels … スライダーの目盛りごとのラベル（スペース区切り）
 *     data-needs  … ここに書いた設定がすべて ON のときだけ、その行を操作可能にする
 *     data-not    … ここに書いた設定が 1 つでも ON なら、その行を操作不可にする
 *     data-reset  … 押すとその範囲の設定を初期化するボタン
 *     data-site   … そのサイトのタブが選ばれているときだけ表示する要素
 *
 * ■ 全体が async の即時実行関数になっている理由
 *   設定の読み込み（await store.get）を待ってから画面を描くためです。
 */
(async () => {
    'use strict';

    // common.js が用意した道具箱から必要なものを取り出します。
    const { api, store, log, KEYS, SITES, siteOf, settingsOf, fix } = globalThis.SLPSTRM ?? {};
    if (!KEYS || !SITES) {
        console.warn('[slipstreamlive] shared/schema.js が読み込まれていません');
        return;
    }

    /** 数値入力欄で、入力が止まってから保存するまでの待ち時間（ミリ秒）。 */
    const COMMIT_MS = 400;
    /** 吹き出しを画面の端から離す余白（ピクセル）。 */
    const PAD       = 8;
    /** ツールチップをマウス位置から右へずらす量（ピクセル）。 */
    const TIP_DX    = 12;
    /** ツールチップをマウス位置から下へずらす量（ピクセル）。 */
    const TIP_DY    = 18;

    /** 対応サイト ID の配列（['youtube', 'twitch', 'twitcasting']）。 */
    const sites  = Object.keys(SITES);

    /** 設定 1 行ぶんの要素（有効/無効の切り替えに使う）。 */
    const rows   = [...document.querySelectorAll('.row')];

    /** @type {Map<string, HTMLButtonElement>} サイト ID → タブボタン */
    const tabs   = new Map();

    /** サイトごとに表示を切り替える要素（選択中のサイトのものだけ表示する）。 */
    const scoped = [...document.querySelectorAll('#scopes [data-site]')];

    /**
     * 画面上のすべての入力欄。
     * `[...document.querySelectorAll(...)]` は、querySelectorAll が返す
     * NodeList を本物の配列に変換する書き方（スプレッド構文）です。
     * filter で、schema.js に定義の無い data-key は警告して除外しています。
     */
    const inputs = [...document.querySelectorAll('[data-key]')].filter((input) => {
        if (KEYS[input.dataset.key]) return true;
        log.warn('unknown data-key', input.dataset.key);
        return false;
    });

    /** @type {string} 現在選択中のサイト ID */
    let current = sites[0];
    /** @type {Record<string, Record<string, unknown>>} 保存されている設定データ全体 */
    let data    = {};
    /** @type {Record<string, unknown>} 画面の状態（最後に選んだタブなど） */
    let ui      = {};
    /** @type {Record<string, { message: string }>|null} 手動で読み込んだ言語ファイル */
    let strings = null;
    /** @type {string} 表示に使う言語タグ（例: 'ja'、'pt-BR'） */
    let locale  = api.i18n.getUILanguage();

    /**
     * 表示用の文言を取り出す。
     * URL で言語を指定されていればそちらを優先し、無ければブラウザの言語設定に従って
     * 拡張機能の多言語機能（i18n.getMessage）から取り出します（見つからなければ空文字）。
     * @param {string} key 文言のキー
     * @returns {string} 対応する文言
     */
    const t = (key) => strings?.[key]?.message ?? api.i18n.getMessage(key);

    /**
     * URL のクエリ（?locale=ja）で指定された言語ファイルを読み込む（開発用）。
     * ブラウザの言語とは違う言語で表示を確認したいとき用の仕組みです。
     * 指定には _locales 内のフォルダ名（例: pt_BR、zh_TW）をそのまま使います。
     *
     * 正規表現で名前を検査しているのは重要なセキュリティ対策です。
     * これが無いと「../」のような文字列で、意図しないファイルを
     * 読み込ませられる（パストラバーサル）恐れがあります。
     * @returns {Promise<void>}
     */
    async function loadLocale() {
        const name = new URLSearchParams(location.search).get('locale');
        if (!name || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) return;
        try {
            const res = await fetch(api.runtime.getURL(`_locales/${name}/messages.json`));
            if (!res.ok) return;
            strings = await res.json();

            // フォルダ名はアンダースコア区切り（zh_TW）ですが、<html lang> に入れる
            // 言語タグはハイフン区切り（zh-TW）が正しい書式です。書式が崩れていると
            // ブラウザが言語を判別できず、漢字の字形（簡体字・繁体字・日本語）を取り違えます。
            locale = name.replaceAll('_', '-');
        } catch (error) {
            log.warn('loadLocale', error);
        }
    }

    /**
     * 画面上の文字をすべて、選択中の言語に置き換える。
     * HTML には文言を直接書かず、data-* 属性でキーだけを指定しておき、
     * ここでまとめて流し込む方式です。
     * @returns {void}
     */
    function translate() {
        document.documentElement.lang = locale;
        document.title = t('appName');

        // マニフェストからバージョン番号を取り出して表示（例: v1.3.1）。
        document.getElementById('version').textContent = `v${api.runtime.getManifest().version}`;

        for (const node of document.querySelectorAll('[data-msg]')) node.textContent = t(node.dataset.msg);
        for (const node of document.querySelectorAll('[data-title]')) node.title = t(node.dataset.title);
        for (const node of document.querySelectorAll('[data-href]')) node.href = t(node.dataset.href);

        // 「0.10 ~ 100.00」のような入力範囲のヒントを、schema.js の定義から自動生成します。
        for (const node of document.querySelectorAll('[data-hint]')) {
            const range = KEYS[node.dataset.hint]?.range;
            if (!range) {
                log.warn('data-hint に数値設定でないキーが指定されています', node.dataset.hint);
                continue;
            }
            const [min, max, step] = range;
            // 刻み幅が 1 以上なら整数、小数刻みなら小数第 2 位まで表示します。
            const digits = step >= 1 ? 0 : 2;
            node.textContent = `${min.toFixed(digits)} ~ ${max.toFixed(digits)}`;
        }
    }

    /**
     * スペース区切りの文字列を配列にする。
     * 例: "enabled speedup" → ['enabled', 'speedup']
     * filter(Boolean) は空文字を取り除くための定番の書き方です。
     * @param {string|undefined} value 変換したい文字列
     * @returns {string[]} 分割した配列
     */
    const list = (value) => (value ?? '').split(' ').filter(Boolean);

    /**
     * 浮かせる要素（吹き出し・ツールチップ）が画面からはみ出さないよう、座標を挟み込む。
     *
     * Math.max(PAD, Math.min(理想の位置, 画面の端 - 大きさ - 余白))
     * → 理想の位置に置きつつ、はみ出すときだけ内側へ押し戻します。
     * @param {number} ideal 理想の座標（左端または上端）
     * @param {number} size 要素の幅または高さ
     * @param {number} limit 画面の幅または高さ
     * @returns {number} 実際に置く座標
     */
    const fit = (ideal, size, limit) => Math.max(PAD, Math.min(ideal, limit - size - PAD));

    /**
     * 現在の設定値を画面に反映する（再描画）。
     * 値が変わったときは必ずこれを呼ぶことで、画面と実データのずれを防ぎます。
     * @returns {void}
     */
    function render() {
        const settings = settingsOf(data, current);

        // CSS 側でサイトごとの色分けをするための目印。
        document.documentElement.dataset.site = current;
        document.getElementById('reset-site').textContent = `${t('reset')} · ${SITES[current].label}`;

        // タブの選択状態を更新（aria-selected はスクリーンリーダー向けの情報でもあり、
        // CSS もこの属性を見て選択中のタブを塗り分けます）。
        for (const [site, tab] of tabs) tab.ariaSelected = String(site === current);

        // 選択中のサイト以外の要素を隠す。
        for (const node of scoped) node.hidden = node.dataset.site !== current;

        // 各入力欄に現在値を流し込む。
        for (const input of inputs) {
            const value = settings[input.dataset.key];
            if (input.type === 'checkbox') input.checked = value;
            // 入力中の欄（＝フォーカスがある欄）は書き換えません。
            // これをしないと、打っている途中で文字が勝手に置き換わってしまいます。
            else if (input !== document.activeElement) input.value = String(value);
        }

        // 行ごとの有効・無効を判定する。
        // 例: 「加速」が OFF のとき、その配下の「加速速度」はグレーアウトさせます。
        for (const row of rows) {
            if (!row.querySelector('[data-key]')) continue;

            // every … data-needs のすべてが ON であること
            // some  … data-not のどれか 1 つでも ON なら不可
            const on = list(row.dataset.needs).every((key) => settings[key])
                && !list(row.dataset.not).some((key) => settings[key]);

            // 入力欄だけでなく「?」ボタンも無効にします。
            // CSS の pointer-events: none はマウス操作しか止められないため、
            // これが無いとキーボード（Tab → Enter）で無効な行の説明が開けてしまいます。
            for (const control of row.querySelectorAll('input, button')) control.disabled = !on;
            row.classList.toggle('disabled', !on);
        }
    }

    /**
     * 指定した保存先の設定をまとめて書き換え、保存して再描画する。
     * @param {string} scope 保存先（'common' またはサイト ID）
     * @param {Record<string, unknown>} values その保存先の新しい設定一式
     * @returns {void}
     */
    function commit(scope, values) {
        // 既存の data を直接書き換えず、新しいオブジェクトを作って差し替えています
        // （イミュータブルな更新。意図しない場所への影響を防ぐ書き方）。
        data = { ...data, [scope]: values };
        store.set('settings', data);
        render();
    }

    /**
     * 設定を 1 つ保存する。
     * 共通設定か、サイト個別かは schema.js の scope を見て自動で振り分けます。
     * @param {string} key 設定キー
     * @param {number|boolean} value 保存する値
     * @param {string} [site=current] 対象サイト
     * @returns {void}
     */
    function save(key, value, site = current) {
        const scope = KEYS[key].scope === 'common' ? 'common' : site;
        commit(scope, { ...data[scope], [key]: value });
    }

    /**
     * 設定を初期化する。
     * 空のオブジェクト {} を保存すると、読み出し時に settingsOf() が
     * すべて既定値で埋めてくれるので、「消す＝初期化」になります。
     * @param {string} scope 'common' なら共通設定、それ以外は現在のサイト
     * @returns {void}
     */
    const reset = (scope) => commit(scope === 'common' ? 'common' : current, {});

    /**
     * 入力欄の文字列を、範囲内の数値として解釈する。
     * @param {HTMLInputElement} input 対象の入力欄
     * @param {number[]} range [最小値, 最大値]（3 番目の刻み幅は使わない）
     * @returns {number|null} 有効な数値。無効なら null
     */
    function parse(input, [min, max]) {
        const num = Number.parseFloat(input.value);
        return Number.isFinite(num) && num >= min && num <= max ? num : null;
    }

    /**
     * ON/OFF スイッチに動作を割り当てる。
     * @param {HTMLInputElement} input チェックボックス要素
     * @param {string} key 設定キー
     * @returns {void}
     */
    function wireSwitch(input, key) {
        input.addEventListener('change', () => save(key, input.checked));
    }

    /**
     * スライダーに動作を割り当てる。
     * つまみを動かしている最中もその都度保存し、ラベル（例:「標準」）を追従表示します。
     * @param {HTMLInputElement} input range 要素
     * @param {string} key 設定キー
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
     * 数値入力欄に動作を割り当てる。
     *
     * ここが少し複雑なのは、入力中の「打っている途中の値」を保存しないためです。
     *   input  … 文字を打つたびに発生。タイマーを毎回リセットし、
     *            手が止まって COMMIT_MS 経ってから保存する（デバウンス処理）。
     *            確定操作をせずに画面を閉じても、打った値が残るようにするためです。
     *   change … 入力を確定した（フォーカスを外した／Enter）ときに発生。
     *            即座に保存し、値を正しい形（刻み幅に丸めた値）に整えて表示し直す。
     *
     * `const site = current` と控えているのは、保存を待っている間にユーザーが
     * 別のサイトのタブへ切り替えても、正しいサイトへ保存されるようにするためです。
     * @param {HTMLInputElement} input number 要素
     * @param {string} key 設定キー
     * @param {number[]} range [最小値, 最大値, 刻み幅]
     * @returns {void}
     */
    function wireNumber(input, key, range) {
        let timer = 0;

        input.addEventListener('input', () => {
            clearTimeout(timer);
            // 範囲外や入力途中（"1." など）の値は、まだ保存しません。
            if (parse(input, range) === null) return;
            const site = current;
            timer = setTimeout(() => save(key, fix(site, key, input.value), site), COMMIT_MS);
        });

        input.addEventListener('change', () => {
            clearTimeout(timer);
            const site = current;

            // 空欄などで数値にならない場合は、保存されている値に戻します。
            if (!Number.isFinite(Number.parseFloat(input.value))) {
                input.value = String(settingsOf(data, site)[key]);
                return;
            }

            // 有効な値なら、刻み幅に丸めた「正式な値」を表示して保存します。
            const value = fix(site, key, input.value);
            input.value = String(value);
            save(key, value, site);
        });
    }

    /**
     * 入力欄の種類を見分けて、適切な動作を割り当てる振り分け役。
     * 最小値・最大値・刻み幅も schema.js の定義から自動で設定します。
     * @param {HTMLInputElement} input 対象の入力欄
     * @returns {void}
     */
    function wireInput(input) {
        const key = input.dataset.key;

        // 行（<label>）と入力欄を、id と for で明示的に結び付けます。
        //
        // 各行の <label> の中には「?」ボタンと入力欄が並んでいます。for を指定しないと、
        // HTML の仕様では「ラベルの中で最初に現れる操作部品」が操作対象になるため、
        // 入力欄より手前にある「?」ボタンが選ばれてしまいます。すると行の文字を押したとき、
        // スイッチが切り替わらずに説明の吹き出しが開く、という食い違いが起きていました。
        input.id = `key-${key}`;
        const label = input.closest('label');
        if (label) label.htmlFor = input.id;

        if (input.type === 'checkbox') return wireSwitch(input, key);

        const { range } = KEYS[key];
        // 配列の分割代入。range の 3 つの値を min / max / step へ一度に代入します。
        [input.min, input.max, input.step] = range;

        return input.type === 'range' ? wireSlider(input, key) : wireNumber(input, key, range);
    }

    /**
     * サイト切り替えタブを動的に作る。
     * HTML に直接書かず、SITES の定義から生成することで、
     * 対応サイトを増やしたときに自動で反映されるようにしています。
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
                // 次回この画面を開いたとき、同じタブを選んだ状態にするため記録します。
                ui = { ...ui, site };
                store.set('ui', ui);
                render();
            });
            bar.append(tab);
            tabs.set(site, tab);
        }
    }

    /**
     * 各設定行の「?」ボタンに、説明の吹き出しを割り当てる。
     *
     * popover は、ブラウザ標準の「他の要素より前面に浮かぶ小窓」機能です。
     * popover="auto" の小窓は、外側をクリックすると自動で閉じます（ライトディスミス）。
     *
     * 位置合わせに一手間かけているのは、
     *   1) いったん画面外（-9999px）に置いて表示する
     *   2) そこで実際の大きさを測る
     *   3) 測った大きさをもとに、画面からはみ出さない位置へ移す
     * という手順が必要なためです（表示前は大きさが測れないので）。
     * @returns {void}
     */
    function buildHelp() {
        for (const icon of document.querySelectorAll('[data-help]')) {
            const bubble = document.createElement('div');
            bubble.className   = 'help';
            bubble.popover     = 'auto';
            bubble.textContent = t(icon.dataset.help);
            document.body.append(bubble);

            // 「?」ボタンを、この吹き出しの「呼び出し元（invoker）」としてブラウザへ登録します。
            //
            // 登録していないと、開いている吹き出しを同じ「?」で閉じようとしたとき、
            //   1) マウスを離した瞬間に「外側のクリック」とみなされて自動で閉じる
            //   2) 直後の click で、閉じたばかりの吹き出しをまた開いてしまう
            // という順に処理され、何度押しても閉じられませんでした。
            // 呼び出し元のクリックは「外側」とみなされなくなるため、この食い違いが起きません。
            // （あわせて、支援技術にも「このボタンが吹き出しを開閉する」ことが伝わります）
            icon.popoverTargetElement = bubble;

            icon.addEventListener('click', (event) => {
                // ブラウザ標準の開閉は止め、開閉と位置合わせをここで一度に行います。
                // 標準の開閉に任せると、開いた直後の一瞬だけ、位置合わせ前の場所に
                // 吹き出しが描かれてしまうことがあるためです。
                event.preventDefault();

                if (bubble.matches(':popover-open')) {
                    bubble.hidePopover();
                    return;
                }

                bubble.style.left = bubble.style.top = '-9999px';
                bubble.showPopover();

                const box = bubble.getBoundingClientRect(); // 吹き出しの大きさ
                const at  = icon.getBoundingClientRect();   // ボタンの位置

                // ボタンの右下に置きつつ、画面からはみ出さないよう挟み込みます。
                bubble.style.left = `${fit(at.right + PAD, box.width, innerWidth)}px`;
                bubble.style.top  = `${fit(at.bottom + PAD, box.height, innerHeight)}px`;
            });
        }
    }

    /**
     * スライダー用のツールチップ（マウスに追従する小さなラベル）。
     *
     * 例：自動しきい値スライダーで、目盛りに応じて
     * 「オフ / 安定 / 標準 / 積極的」と表示を切り替えます。
     * 要素は 1 つだけ作って使い回します（毎回作ると無駄なため）。
     */
    const Tip = (() => {
        const node = document.createElement('div');
        node.className = 'tip';
        node.hidden    = true;
        document.body.append(node);

        let x = 0; // 直近のマウス X 座標
        let y = 0; // 直近のマウス Y 座標

        /**
         * 現在のマウス位置に合わせてツールチップを配置する。
         * 画面外へはみ出さないよう、上下左右で位置を制限します。
         * @returns {void}
         */
        function place() {
            const box = node.getBoundingClientRect();
            node.style.left = `${fit(x + TIP_DX, box.width, innerWidth)}px`;
            node.style.top  = `${fit(y + TIP_DY, box.height, innerHeight)}px`;
        }

        return {
            /**
             * マウス位置を記録し、表示中なら追従させる。
             * @param {PointerEvent} event ポインターイベント
             * @returns {void}
             */
            move(event) {
                x = event.clientX;
                y = event.clientY;
                if (!node.hidden) place();
            },

            /**
             * スライダーの現在値に対応するラベルを表示する。
             *
             * 値からラベルの番号を求める式：
             *   (現在値 - 最小値) / 刻み幅 → 0, 1, 2, 3 …
             * 例）最小 0・刻み 1 のスライダーで値が 2 なら、
             *     data-labels の 3 番目のラベルが選ばれます。
             * @param {HTMLInputElement} input 対象のスライダー
             * @returns {void}
             */
            follow(input) {
                const keys = list(input.dataset.labels);
                const [min, , step] = KEYS[input.dataset.key].range; // 2 番目（max）は使わないので飛ばす
                const key = keys[Math.round((Number.parseFloat(input.value) - min) / step)];
                if (!key) return this.hide();
                node.textContent = t(key);
                node.hidden      = false;
                place();
            },

            /** ツールチップを隠す。 */
            hide() { node.hidden = true; },
        };
    })();

    /**
     * スライダーにツールチップの表示・非表示イベントを割り当てる。
     *
     * 消す条件を 3 つ登録しているのは、消し忘れを防ぐためです。
     *   pointerleave  … マウスが離れた
     *   pointercancel … タッチ操作が中断された
     *   blur          … キーボード操作でフォーカスが外れた
     * @param {HTMLInputElement} input 対象のスライダー
     * @returns {void}
     */
    function wireTip(input) {
        input.addEventListener('pointerenter', (event) => { Tip.move(event); Tip.follow(input); });
        input.addEventListener('pointermove', (event) => Tip.move(event));
        input.addEventListener('pointerleave', () => Tip.hide());
        input.addEventListener('pointercancel', () => Tip.hide());
        input.addEventListener('blur', () => Tip.hide());
    }

    /**
     * 最初に開くタブ（サイト）を決める。
     *
     * 優先順位：
     *   1) 今アクティブなタブが対応サイトなら、そのサイト
     *      （アイコンのクリックで activeTab 権限が一時的に付くため、URL を読めます）
     *   2) content.js が記録した「最後に見ていたサイト」
     *   3) 前回この画面で選んでいたサイト
     *   4) それも無ければ先頭のサイト
     * @returns {Promise<string>} サイト ID
     */
    async function detect() {
        try {
            const [tab] = await api.tabs.query({ active: true, currentWindow: true });
            const site = tab?.url ? siteOf(new URL(tab.url).hostname) : null;
            if (site) return site;
        } catch (error) {
            log.say('tabs.query', error);
        }

        if (sites.includes(ui.seen)) return ui.seen;
        if (sites.includes(ui.site)) return ui.site;
        return sites[0];
    }

    // =========================================================================
    // ここからが実際の起動処理。上で定義した部品を順番に組み立てていきます。
    // =========================================================================

    await loadLocale();                              // 言語ファイルの読み込み（?locale= 指定時のみ）
    translate();                                     // 画面の文字を翻訳
    for (const input of inputs) wireInput(input);    // 入力欄に動作を割り当て

    // 「リセット」ボタンに動作を割り当て
    for (const button of document.querySelectorAll('[data-reset]')) {
        button.addEventListener('click', () => reset(button.dataset.reset));
    }

    buildTabs();                                     // サイト切り替えタブを生成
    buildHelp();                                     // 「?」の吹き出しを生成

    ui      = await store.get('ui');                 // 画面の状態を読み込み
    data    = await store.get('settings');           // 設定を読み込み
    current = await detect();                        // 開くタブを決定
    render();                                        // 画面に反映

    // 他の場所（別ウィンドウの設定画面など）で設定が変わったら、この画面も追従させます。
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
            data = changes.settings.newValue ?? {};
            render();
        }
    });
})();
