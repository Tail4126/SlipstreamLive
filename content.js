// SPDX-License-Identifier: Apache-2.0 OR MIT
/* ================================================================================================
 * content.js — 設定を「MAIN world へ橋渡し」する係
 *              （ISOLATED world / document_start / すべてのフレームへ注入）
 *
 * 【どこから呼ばれるか】
 *   manifest.json の content_scripts（1 個目のエントリ）から、shared/schema.js → common.js の
 *   順に読み込まれた最後に読み込まれ、その場で自動実行される。誰かが呼び出す関数は持たない。
 *
 * 【なぜこのファイルが必要か】
 *   実際にプレイヤーを操作する inject.js は MAIN world で動くため、chrome.storage を読めない。
 *   逆にこの content.js は ISOLATED world なので storage を読めるが、プレイヤー内部には触れない。
 *   両者が唯一共有できるのは「同じ DOM」だけ。そこで、
 *
 *     storage ──(このファイル)──> <html data-slpstrm='{"enabled":true,...}'> ──> inject.js
 *
 *   という経路で設定を受け渡している。属性値は JSON 文字列。
 *
 * 【もう一つの仕事】
 *   最上位フレームかつ画面が表示中のとき、「今どのサイトを見ているか」を storage へ記録する。
 *   ポップアップを開いたとき、対象サイトのタブを自動で選ぶために使う。
 * ================================================================================================ */
(() => {
    'use strict';

    // common.js が用意した窓口から、このファイルで使うものだけを取り出す
    const { api, store, log, siteOf, settingsOf } = globalThis.SLPSTRM ?? {};

    // 読み込み順が壊れて設計図が合流していない場合は、例外を投げずに静かに終了する
    if (!siteOf || !settingsOf) return;

    // 現在のホスト名から特定した対応サイト識別子（'youtube' / 'twitch' / 'twitcasting' / null）
    const site = siteOf();
    if (!site) return;                  // 非対応サイトなら何もせず終了

    let json     = null;                // 直近に書き込んだ設定 JSON 文字列。同じ内容の書き込みを省いて無駄な DOM 更新を避けるキャッシュ
    let observer = null;                // data-slpstrm 属性の改ざん・削除を見張る監視役。初回の write() で一度だけ作る

    /**
     * 設定 JSON を <html data-slpstrm="..."> 属性へ書き出す。
     *
     * document_start の時点では <html> 要素すら存在しないことがあるため、必ず存在を確認する。
     * また初回の書き込み時に MutationObserver を仕掛け、ページ側スクリプトが属性を
     * 書き換えたり消したりしても自動で書き戻せるようにしている
     * （MutationObserver のコールバックにこの write 自身を渡しているのがその仕組み）。
     *
     * @returns {void}
     */
    function write() {
        const root = document.documentElement; // <html> 要素
        if (!root || json === null) return;    // まだ書けない状態なら何もしない

        if (root.dataset.slpstrm !== json) root.dataset.slpstrm = json;

        if (!observer) {
            observer = new MutationObserver(write);
            observer.observe(root, { attributes: true, attributeFilter: ['data-slpstrm'] });
        }
    }

    /**
     * storage の生データから実効設定を組み立て直し、DOM へ反映する。
     *
     * @param {Object} data - storage の 'settings' キーから読み出した生データ
     * @returns {void}
     */
    function apply(data) {
        json = JSON.stringify(settingsOf(data, site));
        log.say('settings', site, json);
        write();
    }

    /**
     * 「今このサイトを見ている」ことを storage へ記録する。
     * ポップアップ側（popup.js の detect()）が起動時のタブ選択に使う。
     *
     * iframe の中や、裏に回ったタブからの通知は誤選択のもとになるため無視する。
     *
     * @returns {Promise<void>}
     */
    async function announce() {
        if (window.top !== window || document.hidden) return; // iframe 内 / 非表示タブなら記録しない

        const ui = await store.get('ui'); // { site: 手動選択, seen: 直近の閲覧サイト }
        if (ui.seen !== site) await store.set('ui', { ...ui, seen: site });
    }

    // ポップアップでの設定変更をリアルタイムに反映する（拡張機能内の全ページへ通知が届く）
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) apply(changes.settings.newValue ?? {});
    });

    // 裏タブからアクティブへ切り替わったら、閲覧中サイトを改めて通知する
    document.addEventListener('visibilitychange', () => { if (!document.hidden) announce(); });

    // document_start の時点で <html> が未生成だった場合に備えた書き込みの保険（一度だけ実行）
    document.addEventListener('readystatechange', write, { once: true });

    // --- 初期化 ---------------------------------------------------------------------------------
    // storage の読み出しは非同期。待っている間に onChanged が先に走って apply() 済みの可能性があるため、
    // json が未設定（null）のときだけ適用して、新しい設定を古い設定で上書きしないようにする
    store.get('settings').then((data) => { if (json === null) apply(data); });
    announce();
})();
