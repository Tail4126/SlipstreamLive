// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * background.js — バックグラウンドで動く「裏方」スクリプト
 * =============================================================================
 *
 * ■ このファイルは何をするもの？
 *   ページとは無関係に、拡張機能そのものに紐づいて動くスクリプトです。
 *   Chrome では Service Worker、Firefox ではイベントページとして読み込まれ、
 *   必要なときだけ起動して、仕事が終わると自動で停止します（常駐しません）。
 *
 *   この拡張機能では、やることは 2 つです。
 *     1) 「アンインストールされたときに開くページ（アンケート）」を登録する
 *     2) ユーザーが許可したサイト（DAZN）で動かすスクリプトを登録する
 *
 * ■ 2) が必要な理由
 *   YouTube・Twitch・ツイキャス・TikTok のスクリプトは manifest の content_scripts に
 *   書いてありますが、そこへ新しいホストを足すと、Chrome は更新時に権限の承認を求め、
 *   承認されるまで全利用者の拡張機能を無効にします。Firefox（Manifest V3）は、更新で
 *   増えたホストの権限を付与しないため、足したサイトでは動きません。
 *   そこで DAZN は optional_host_permissions に置き、設定画面の「このサイトで有効にする」で
 *   ユーザーに許可をもらってから、ここで scripting.registerContentScripts() を使って
 *   manifest に書いたのと同じ 2 組のスクリプト（ISOLATED world と MAIN world）を登録します。
 *   許可が取り消されたら登録も外します。
 *
 * ■ 動くタイミング
 *   バックグラウンドが起動するたびに、アンケートの URL を登録し直し、スクリプトの登録を
 *   「いま付いている許可」に合わせ直します（start()）。何度やっても結果は同じです。
 *     - ブラウザの起動時      … runtime.onStartup
 *     - インストール・更新時  … runtime.onInstalled（更新すると登録したスクリプトは消えるため、
 *                               ここで登録し直します。MDN の persistAcrossSessions の説明を参照）
 *     - 許可が付いた・外れた  … permissions.onAdded / onRemoved
 *   許可が付いたときは、すでに開いているそのサイトのタブにもスクリプトを入れます（adopt()）。
 *   登録したスクリプトは、これから読み込まれるページにしか入らないため、こうしないと
 *   「有効にする」を押したあと、ページを再読み込みするまで動かないからです。
 *
 * ■ イベントリスナーと Firefox のイベントページ（変更するときの注意）
 *   Chrome は登録したアンケートの URL をブラウザ側の設定に保存するので、一度登録すれば足ります。
 *   一方 Firefox は URL をメモリ上にしか持たないため、ブラウザを起動するたびに
 *   このスクリプトが動いて登録し直す必要があります。
 *
 *   Firefox のイベントページは、「永続化されたリスナー」（runtime.onInstalled などを
 *   トップレベルで登録したもの）を持っていると、ブラウザ起動時に自動では起動されず、
 *   イベントが届くまで待つようになります。ただし runtime.onStartup にリスナーがあれば、
 *   起動時にそのイベントを届けるために必ず起動されます（Firefox の ext-backgroundPage.js）。
 *   このファイルは permissions.onAdded などのリスナーを持つので、runtime.onStartup の
 *   リスナーは消さないでください。消すと、2 回目以降の起動でアンケートが開かなくなります。
 *   インストール・更新・有効化のときは、リスナーの有無にかかわらずすぐに起動されます。
 */
'use strict';

// 対応サイトの一覧（SITES）は shared/schema.js にあります。
// Chrome の Service Worker では importScripts() で読み込みます。
// Firefox のイベントページには importScripts() が無く、代わりに manifest の
// background.scripts でこのファイルより先に読み込まれています。
if (typeof importScripts === 'function') importScripts('shared/schema.js');

// schema.js が置いていった一時変数を受け取り、すぐ消します（common.js と同じ受け取り方）。
// 読み込めなかった場合は SITES が空になり、アンケートの登録だけを行います。
const { SITES = {} } = globalThis.__slipstreamliveSchema ?? {};
delete globalThis.__slipstreamliveSchema;

/** アンインストール時に開くアンケートフォームの URL。識別子などは一切付けません。 */
const SURVEY_URL = 'https://forms.gle/d6kbXD7QREL1VSmk9';

/**
 * 許可を得てから動かすサイトの ID（SITES のうち origins を持つもの）。例: ['dazn']
 * @type {string[]}
 */
const OPTIONAL_SITES = Object.keys(SITES).filter((site) => SITES[site].origins?.length > 0);

/**
 * ISOLATED world に入れるファイル。manifest の 1 つ目の content_scripts と同じ並びです
 * （設定を読んで <html> の data-slpstrm 属性へ書く content.js と、その下準備）。
 */
const ISOLATED_FILES = ['shared/schema.js', 'common.js', 'content.js'];

/**
 * MAIN world に入れるファイル。manifest のサイト別の content_scripts と同じ並びで、
 * アダプターのファイル名はサイト ID から決めます（dazn → adapters/dazn.js）。
 * @param {string} site サイト ID
 * @returns {string[]} 読み込む順に並べたファイル
 */
const mainFiles = (site) => ['shared/util.js', `adapters/${site}.js`, 'inject.js'];

/**
 * そのサイト用に登録するスクリプト 2 組を組み立てる。
 *
 * manifest.json の content_scripts と同じ指定です。
 *   - runAt: 'document_start' … ページのスクリプトより先に動く
 *   - allFrames: true         … iframe の中のプレーヤーにも入る
 *   - world: 'MAIN'           … inject.js はページと同じ実行環境で動き、video 要素の速度を横取りする
 *   - persistAcrossSessions   … ブラウザを再起動しても登録を残す
 * id は拡張機能の中で一意であればよく、先頭に「_」は使えません（ブラウザの予約）。
 * @param {string} site サイト ID
 * @returns {object[]} registerContentScripts() にそのまま渡せる配列
 */
function scriptsOf(site) {
    const shared = {
        matches: SITES[site].origins,
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: true,
    };
    return [
        { ...shared, id: `${site}-isolated`, js: ISOLATED_FILES, world: 'ISOLATED' },
        { ...shared, id: `${site}-main`, js: mainFiles(site), world: 'MAIN' },
    ];
}

/**
 * アンインストール時に開く URL を登録する。
 * 失敗しても拡張機能の本来の機能には影響しないので、警告を出すだけにとどめます。
 * @returns {Promise<void>}
 */
async function survey() {
    try {
        await browser.runtime.setUninstallURL(SURVEY_URL);
    } catch (error) {
        console.warn('[slipstreamlive] setUninstallURL', error);
    }
}

/**
 * 1 サイトぶんのスクリプトの登録を、いまの許可の状態に合わせる。
 *
 *   許可あり … 未登録のものを登録し、登録済みのものは中身を最新の定義で上書きする
 *              （更新でファイルの並びが変わっても、古い定義が残らないように）
 *   許可なし … 登録済みのものを外す
 * @param {string} site サイト ID
 * @returns {Promise<void>}
 */
async function reconcileSite(site) {
    const scripts = scriptsOf(site);
    const [granted, registered] = await Promise.all([
        browser.permissions.contains({ origins: SITES[site].origins }),
        browser.scripting.getRegisteredContentScripts({ ids: scripts.map((script) => script.id) }),
    ]);
    const have = new Set(registered.map((script) => script.id));

    if (!granted) {
        if (have.size) await browser.scripting.unregisterContentScripts({ ids: [...have] });
        return;
    }

    const known = scripts.filter((script) => have.has(script.id));
    const fresh = scripts.filter((script) => !have.has(script.id));
    if (known.length) await browser.scripting.updateContentScripts(known);
    if (fresh.length) await browser.scripting.registerContentScripts(fresh);
}

/**
 * 許可制のすべてのサイトについて、登録を合わせる。1 サイトの失敗で他を止めません。
 * @returns {Promise<void>}
 */
async function reconcile() {
    for (const site of OPTIONAL_SITES) {
        try {
            await reconcileSite(site);
        } catch (error) {
            console.warn('[slipstreamlive] registerContentScripts', site, error);
        }
    }
}

/** @type {Promise<void>} いま走っている reconcile()。次の呼び出しはこの後ろに並べます */
let syncing = Promise.resolve();

/**
 * 登録を合わせる（reconcile）を、前の呼び出しが終わってから走らせる。
 *
 * 起動直後の start() と permissions.onAdded のように、同じタイミングで何度か呼ばれることが
 * あります。同時に走ると、どちらも「未登録」と見て同じ id を 2 回登録しようとし、
 * 後のほうが「id が重複している」というエラーになるため、1 本の列に並べます。
 * （Service Worker が止まると列も消えますが、止まっている間は誰も呼ばないので問題ありません）
 * reconcile() は失敗を自分で受け止めますが、万一前の呼び出しが拒否されても列が止まらないよう、
 * then() の 2 つ目の引数にも同じ関数を渡しています。
 * @returns {Promise<void>}
 */
function sync() {
    syncing = syncing.then(reconcile, reconcile);
    return syncing;
}

/**
 * 許可が付いたサイトの、すでに開いているタブへスクリプトを入れる。
 *
 * registerContentScripts() で登録したスクリプトは、これから読み込まれるページにだけ入ります。
 * 開いたままのページにもその場で入れることで、再読み込み（ライブ配信の読み込み直し）を
 * しなくても、許可した直後から動くようにします。
 * 万一、同じページに 2 回入っても、inject.js は二重起動を防ぐ印（window.__slipstreamlive）で
 * 2 回目を止め、content.js は同じ設定を同じ属性に書くだけなので、動きは変わりません。
 * @param {{ origins?: string[] }} added permissions.onAdded が渡す「新しく付いた許可」
 * @returns {Promise<void>}
 */
async function adopt(added) {
    const origins = added?.origins ?? [];
    for (const site of OPTIONAL_SITES) {
        const wanted = SITES[site].origins;
        if (!wanted.some((origin) => origins.includes(origin))) continue;

        let tabs = [];
        try {
            if (!await browser.permissions.contains({ origins: wanted })) continue;
            tabs = await browser.tabs.query({ url: wanted });
        } catch (error) {
            console.warn('[slipstreamlive] tabs.query', site, error);
            continue;
        }

        for (const tab of tabs) {
            const target = { tabId: tab.id, allFrames: true };
            try {
                // 設定を属性へ書く側（ISOLATED）を先に入れ、それを読む側（MAIN）を後に入れます。
                await browser.scripting.executeScript({ target, files: ISOLATED_FILES });
                await browser.scripting.executeScript({ target, files: mainFiles(site), world: 'MAIN' });
            } catch (error) {
                // 破棄されたタブや、まだ読み込み中のタブでは失敗することがあります。
                // その場合も、次にページを読み込んだときから登録したスクリプトが動きます。
                console.warn('[slipstreamlive] executeScript', site, tab.id, error);
            }
        }
    }
}

/**
 * バックグラウンドが起動するたびに 1 度だけ行う仕事。
 * どの理由で起動しても（ブラウザの起動・更新・許可の変化など）、ここが最初に動きます。
 * @returns {Promise<void>}
 */
async function start() {
    await survey();
    await sync();
}

/** @type {Promise<void>} この起動での start() の結果。リスナーはこれを待ってから動きます */
const started = start();

// --- ここから下がイベント登録。リスナーはすべてトップレベルで同期的に登録します ---
// （Service Worker もイベントページも、起動のたびにここが動いてリスナーが付け直されます。
//   await の後で登録すると、そのイベントで起こされたときに取りこぼします）

// ブラウザの起動時とインストール・更新時。仕事は start() が済ませているので、それを待つだけです。
// どちらも「このタイミングでバックグラウンドを起こしてもらう」ために登録しています
// （runtime.onStartup を残す理由は冒頭の注意を参照）。
browser.runtime.onStartup.addListener(() => started);
browser.runtime.onInstalled.addListener(() => started);

// 許可が付いたら、スクリプトを登録してから、開いているタブにも入れます。
// 設定画面のボタンから許可したときも、ブラウザの拡張機能の管理画面から許可したときも、ここに来ます。
browser.permissions.onAdded.addListener(async (added) => {
    await started;
    await sync();
    await adopt(added);
});

// 許可が外れたら、登録を外します（開いているページは、再読み込みするまで今のまま動きます）。
browser.permissions.onRemoved.addListener(async () => {
    await started;
    await sync();
});
