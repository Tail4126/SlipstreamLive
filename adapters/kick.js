// SPDX-License-Identifier: Apache-2.0 OR MIT
/**
 * =============================================================================
 * adapters/kick.js — Kick 専用の「アダプター」
 * =============================================================================
 *
 * ■ このサイトも、DAZN と同じく許可制で読み込まれる
 *   Kick のスクリプトは manifest に書いていません。ユーザーが設定画面の「このサイトで有効にする」で
 *   kick.com（と埋め込み用の player.kick.com）へのアクセスを許可したときに、background.js が
 *   scripting.registerContentScripts() で「shared/util.js → このファイル → inject.js」を
 *   MAIN world に登録します（並びは manifest と同じ）。許可が無いあいだは、どのページにも読み込まれません。
 *
 * ■ Kick のプレーヤー
 *   kick.com と player.kick.com は、どちらも Amazon IVS の Web プレーヤー（Twitch のプレーヤーと同じ系統）で
 *   低遅延の HLS を再生します。プレーヤーの本体は Worker の中で動き、<video> には MediaSource の
 *   受け渡し口（srcObject が MediaSourceHandle）がつながっています。速度（playbackRate）と
 *   読み込み済みの範囲（buffered）は、ふつうの <video> と同じように扱えます。
 *     - kick.com の本編は <video id="video-player">。チャンネル内のページを移っても同じ要素を使い続け、
 *       アーカイブ（VOD）も同じ要素で再生します。
 *     - player.kick.com（他のサイトに埋め込まれるプレーヤー）の <video> には id がありません。
 *       そのため id が見つからないときは、画面にいちばん大きく映っている <video> を選びます。
 *
 * ■ IVS プレーヤーの実体の探し方
 *   遅延と広告を知るには、IVS プレーヤーの実体（getLiveLatency などを持つオブジェクト）が要ります。
 *   どちらのページも React で作られているので、Twitch と同じく React の内部データ（fiber）を辿って探し、
 *   getHTMLVideoElement() が今の <video> と一致するものだけを採用します（別のプレーヤーと取り違えないため）。
 *     - player.kick.com は <video> の祖先のコンポーネントが useRef で持っているので、上へ辿れば見つかります。
 *     - kick.com はプレーヤーを別の場所で作り、<video> をページ内へ差し込む作り（reverse portal）のため、
 *       祖先には実体がありません。ツリー全体を探します（2026 年 11 月の実測で、約 9,000 ノード中 1,300 番目あたり）。
 *   見つからなくても制御は続きます（遅延の表示が「受信済みの末尾からの遅れ」になるだけです）。
 *
 * ■ ライブ判定・遅延・広告
 *   - ライブは動画の長さ（duration）が Infinity になります。アーカイブ（配信中の回のアーカイブを含む）と
 *     クリップは長さが決まっているので、対象外になります。
 *   - 遅延は「今の時刻 − 再生中の映像の時刻（プログラム日時）」です（求め方は lag() を参照）。
 *     IVS の getLiveLatency() もライブの最前線では同じ値を返しますが、巻き戻すと 10 秒以上も前の値のまま
 *     止まっていたため（実測）、映像の時刻が使えないときの代わりにだけ使います。
 *     最前線にいるかどうか（DVR の判定）は tracker で推定します。
 *   - IVS には Twitch と同じ「追いつくための自動加速」（setLiveSpeedUpRate）があります。2026 年 11 月の
 *     実測では Kick はこれを使っていませんでしたが、使い始めても互いに速度を奪い合わないよう、
 *     Twitch と同じく 1 倍に固定し直します。
 *   - Kick の広告は 2 種類あります。IVS が配信の映像そのものに差し込む広告（サーバー側の広告挿入）は、
 *     IVS が PlayerAdBreakStarted / PlayerAdBreakEnded の合図を出すので、その間は制御しません。
 *     Google IMA の広告（配信の前に流れるもの）は別の <video title="Advertisement"> で流れるので、
 *     そもそも制御の対象に選びません。
 *
 * ■ Kick で加速すると何が起きるか（実測）
 *   Kick の低遅延配信は、ふだんはバッファが 1.3〜2.5 秒ほどで安定し、データは 0.05〜0.4 秒刻みで
 *   小刻みに届きます。ところが 2026 年 11 月の実測では、データの到着が 10 秒ほど止まることがあり、
 *   そのあいだに再生が止まると、届かなかった分がまとめて届いて、以後は 10 秒ほど遅れたまま再生が続きました
 *   （IVS はこのとき自分では追いつきません）。Slipstream Live は、この溜まったバッファを使って最前線へ戻ります
 *   （同じ実測で、バッファ約 12 秒・遅延約 12 秒の状態から、1.25 倍で約 40 秒かけて遅延 1.6 秒前後まで戻りました）。
 *   この途切れが頻繁なため、Kick の既定値は自動調整をオフにし、先読みを 5 秒ほど残して、残り 2 秒からは
 *   最低速度で途切れをつなぐ設定にしています（shared/schema.js の KEYS を参照）。
 *
 * ■ 読み込み中のまま止まったときの復帰（heal）
 *   Kick のプレーヤーは、IVS の状態が Buffering のあいだ、画面の中央に読み込み中のくるくる表示を出します。
 *   データの途切れの後などに、エラーも出さずに Buffering のまま再生位置が進まなくなり、ページを
 *   読み込み直すまで戻らないことがあります。Kick 自身にも再接続の仕組み（間隔を倍々に延ばしながら 5 回まで
 *   読み込み直す）はありますが、それが動くのは IVS がエラーを出したとき（ネットワークのエラーや
 *   再生用トークンの期限切れ）だけで、エラーの無い Buffering には何もしません。
 *   そこで、この状態を見張って代わりに立て直します（heal()）。
 *
 *   2026 年 11 月の実機（Chrome、kick.com のライブ配信）で確かめたこと：
 *     - IVS は、シーク（seekTo）を頼んでから完了の知らせが届くまでのあいだ、再生位置を Worker へ伝えません
 *       （本体の onSinkTimeUpdate() が、シークの途中なら何もしないため）。シークが完了しないまま残ると、
 *       Worker は再生位置が進んでいないと思い込んで先読みをやめ、エラーの無い Buffering が 2 分近く続きました
 *       （<video> の再生位置をバッファの先へ直接動かして、この状態を作りました）。このとき isSeeking() は
 *       true のままで、load() で読み込み直しても残りました（読み込み直した後も、約 30 秒で同じように止まりました）。
 *       今の再生位置へ seekTo() し直すと、約 0.2 秒でシークが完了して再生が戻りました。
 *     - それ以外の止まり方には、Kick 自身の再試行と同じ load(getPath()) と setAutoplay(true) が効きます。
 *       約 1 秒で、最前線から再生し直しました（再生セッションの ID が変わります）。
 *     - 再生用のトークンは約 10 分で期限が切れます。期限切れのまま load() すると IVS が認証のエラー
 *       （ErrorAuthorization・code 7）を出しますが、Kick 自身の再接続が新しいトークンを取り直して、約 4 秒で戻りました。
 *       この拡張機能が自分でトークンを取りに行く（通信する）ことはありません。
 *     - 速度を変えずに（等倍・先読み 1.3〜2 秒ほどで）見ていると、自然に戻るまで 8〜9.5 秒かかる読み込み中が
 *       何度も起きました。heal() を動かしておくと、5 分ほどのあいだに 4 回、止まって 6.5 秒前後で読み込み直し、
 *       どれも約 1 秒で最前線から再生に戻りました。映像が本当に途絶えていたのではなく、IVS が受信の待ちから
 *       抜け出せずにいたとみられます（ときどき「Read response timeout」という回復可能なエラーも出ていました）。
 *   そこで、読み込み中のまま再生位置が HEAL_WAIT[0] だけ進まなければ、残ったシークがあれば seekTo() で終わらせ、
 *   無ければ（または、それでも戻らなければ）load() で読み込み直します。間隔を広げながら数回だけ試し、
 *   駄目なら打ち切ります。一時停止中・広告中・アーカイブには手を出しません。
 *
 * ■ バッジの位置
 *   コントロールバー下段の左側（再生・音量・経過時間・LIVE）の末尾に並べます（host() を参照）。
 *   Kick はマウスを動かしたときだけコントロールバーを作り、約 4 秒で DOM から取り除きます
 *   （隠すのではなく、要素ごと消します）。そのあいだバッジはページの外の入れ物に預けて見えなくし、
 *   コントロールバーと一緒に現れたり消えたりさせます（YouTube や Twitch と同じ見え方です）。
 *
 * ■ アダプターの役割については adapters/youtube.js の冒頭コメントを参照。
 */
(() => {
    'use strict';

    const util = globalThis.__slipstreamliveUtil;
    if (!util) return;

    const { tracker, toNum, safeCall, registerSite, ENDLESS, BADGE_STYLE_PLAIN } = util;

    /** このアダプターを使うホスト名（kick.com と player.kick.com）。 */
    const HOST = /(^|\.)kick\.com$/;

    /** kick.com の本編の <video> の id。 */
    const MAIN_ID = 'video-player';

    /**
     * 広告の <video>（Google IMA の SDK が作るもの）。ページ全体から選ぶときに除外します。
     * title は IMA が付ける固定の文字列で、表示言語によって変わりません（日本語の画面でも同じでした）。
     */
    const AD_VIDEO = '[title="Advertisement"]';

    /**
     * コントロールバーの再生／一時停止ボタンのアイコンと、音量のアイコン・スライダー。
     * クラス名は Tailwind の汎用の名前ばかりで目印にならないため、Kick のデザインシステムが
     * アイコンに付けている data-ds-icon（Pause・Play・SoundOff・SoundLoud など）で探します。
     * 音量のスライダーの aria-label は、日本語の画面でも "Volume" のままでした。
     */
    const PLAY   = '[data-ds-icon="Pause"], [data-ds-icon="Play"]';
    const VOLUME = '[data-ds-icon^="Sound"], [aria-label="Volume"]';

    /** 再生アイコンから、ボタンが並ぶ箱まで何階層まで上へたどるか。 */
    const CLIMB = 3;

    /** つかんでいる video が健在でも、念のため探し直す間隔（ミリ秒）。 */
    const RECHECK_MS = 500;

    /**
     * IVS プレーヤーの実体が見つからないときに探し直す間隔（ミリ秒）。
     * 見つからないたびに倍へ延ばし（最長 SEARCH_MAX_MS）、ツリー全体の探索を繰り返しすぎないようにします。
     */
    const SEARCH_MS     = 1000;
    const SEARCH_MAX_MS = 8000;

    /** <video> から祖先方向へ辿る段数の上限。 */
    const UPWARD = 40;

    /** React ツリー全体を辿るときの探索上限（ノード数）。kick.com のチャンネルページは約 9,000 ノードでした。 */
    const BUDGET = 30000;

    /** 1 つのコンポーネントで見るフックの数の上限。 */
    const HOOKS = 80;

    /** IVS 自身の自動加速を無効化し直す間隔（ミリ秒）。Twitch と同じです。 */
    const TAME_MS = 2000;

    /** 読み込み中のまま止まっていないかを確かめる間隔（ミリ秒）。Twitch と同じです。 */
    const HEAL_POLL_MS = 500;

    /**
     * 復帰を試みる間隔（ミリ秒）。
     *
     * 先頭の値は「読み込み中のまま再生位置が進まなくなってから 1 回目まで」の猶予で、
     * 2 つ目以降は前回の試行からの間隔です（2 回目以降も、今の止まりが先頭の値以上続いていることが条件です）。
     * 配列の長さがそのまま試行回数の上限になり、配信が本当に止まっているときに延々と挑み続けないための歯止めになります。
     *
     * 先頭を 6 秒にしているのは、ふつうのバッファ切れ（数秒で戻るもの）には手を出さないためです。
     * Kick の既定値では 16 秒ほどの途切れまで止まらずにつなぐので、そこからさらに 6 秒止まっていれば、
     * 自然には戻らない状態とみなせます。読み込み直しは約 1 秒で済むので、待ちすぎるよりは早めに試します。
     */
    const HEAL_WAIT = [6000, 8000, 15000, 30000];

    /** 正常な再生がこれだけ続いたら、試行回数を忘れる（ミリ秒）。Twitch と同じです。 */
    const HEAL_CLEAR_MS = 5000;

    /**
     * 再生位置がこれ以上動いたら「止まっていない」とみなす幅（秒）。
     * seekTo() で今の位置へシークし直すと、位置が 0.03 秒ほど動くことがあるため、少し幅を持たせます。
     */
    const HEAL_MOVED = 0.25;

    /**
     * IVS が、映像に差し込まれた広告の始まりと終わりに出すイベントの名前。
     * PlayerAdCreativeStarted（広告 1 本ごとの始まり）も「始まり」として扱うのは、
     * 広告枠の途中でプレーヤーの実体を見つけた場合でも、次の 1 本から気付けるようにするためです。
     */
    const AD_ON  = ['PlayerAdBreakStarted', 'PlayerAdCreativeStarted'];
    const AD_OFF = ['PlayerAdBreakEnded'];

    /**
     * 映像の時刻（getSyncTime）の刻み（秒）と、その推定を作り直す幅（秒）。
     * IVS は映像の時刻を 1 秒単位でしか返さないので、ずれが刻みの幅を超えて変わったときだけ
     * 「別の時間軸に移った」（シーク・配信の切れ目・別の配信）とみなします。
     */
    const QUANTUM = 1;
    const RESYNC  = QUANTUM + 0.5;

    /**
     * 映像の時刻から求めた遅延を信じる範囲（秒）。DAZN と同じ考え方で、端末の時計のわずかなずれによる
     * マイナスは 0 に丸め、大きくずれているとき（範囲の外）は IVS の getLiveLatency() に切り替えます。
     */
    const WALL_MIN = -5;
    const WALL_MAX = 86400;

    /**
     * IVS プレーヤーの実体が、すでに破棄されているかどうか。
     *
     * 破棄された実体は内部の core が null になり、ほとんどのメソッドが呼ばれるたびに
     * 「Method called on deleted player instance.」という警告をコンソールへ出します。
     * 探索や確認のたびに警告を出させないよう、呼ぶ前にここで確かめます。
     * core というプロパティが無い（IVS の作りが変わった）ときは、破棄されていないものとして扱います。
     * @param {object} value IVS プレーヤーの実体
     * @returns {boolean} 破棄されていれば true
     */
    const deleted = (value) => 'core' in value && !value.core;

    /**
     * 値が「指定の <video> を再生している IVS プレーヤーの実体」かどうか。
     * ページ側のオブジェクトは何が仕込まれているか分からないので、読むだけでも例外に備えます。
     * @param {unknown} value 調べる値
     * @param {HTMLVideoElement} video 対象の video 要素
     * @returns {boolean} そうなら true
     */
    function owns(value, video) {
        if (value === null || typeof value !== 'object') return false;
        try {
            return typeof value.getLiveLatency === 'function'
                && typeof value.getHTMLVideoElement === 'function'
                && !deleted(value)
                && value.getHTMLVideoElement() === video;
        } catch {
            return false;
        }
    }

    /**
     * React の内部ノード 1 つから、IVS プレーヤーの実体を取り出す。
     *
     * 見るのは次の 2 か所です（どちらも 2026 年 11 月の Kick で実際に置かれていた場所です）。
     *   - props の値           … kick.com は videoPlayer という名前で子のコンポーネントへ渡しています
     *   - フック（関数コンポーネントの状態）の値
     *       そのまま     … kick.com は状態の保管庫から読み出した値として持っています
     *       .current     … player.kick.com は useRef で持っています
     *       [0]          … useMemo で持つ形にも備えます
     * @param {object} node React の内部ノード（fiber）
     * @param {HTMLVideoElement} video 対象の video 要素
     * @returns {object|null} 見つかった実体。無ければ null
     */
    function holder(node, video) {
        const props = node.memoizedProps;
        if (props !== null && typeof props === 'object') {
            for (const key of Object.keys(props)) {
                if (owns(props[key], video)) return props[key];
            }
        }

        // フックの連なりを持つのは、関数コンポーネント（0）・forwardRef（11）・memo（15）だけです。
        if (node.tag !== 0 && node.tag !== 11 && node.tag !== 15) return null;
        for (let hook = node.memoizedState, i = 0; hook && i < HOOKS; hook = hook.next, i++) {
            const state = hook.memoizedState;
            if (owns(state, video)) return state;
            if (state === null || typeof state !== 'object') continue;
            if (owns(state.current, video)) return state.current;
            if (Array.isArray(state) && owns(state[0], video)) return state[0];
        }
        return null;
    }

    /**
     * React の内部データを辿って、video を再生している IVS プレーヤーの実体を探す。
     *
     *   1) video の祖先を上へ（最大 UPWARD 段）。player.kick.com はここで見つかります。
     *   2) ツリーの根から全体を（最大 BUDGET ノード）。kick.com はここで見つかります。
     * どちらも探索量に上限を設け、React のツリーが巨大なときもページを固まらせないようにしています。
     * @param {HTMLVideoElement} video 対象の video 要素
     * @returns {object|null} 見つかった実体。無ければ null
     */
    function search(video) {
        // React は DOM 要素に `__reactFiber$xxxxx` という名前のプロパティを付けます（末尾は毎回変わります）。
        const key = Object.keys(video).find((name) => name.startsWith('__reactFiber$'));
        let node = key ? video[key] : null;
        if (!node) return null;

        let top = node;
        for (let i = 0; node && i < UPWARD; node = node.return, i++) {
            const hit = holder(node, video);
            if (hit) return hit;
            top = node;
        }

        // 根（親を持たないノード）まで上ります。段数には念のため上限を設けます。
        for (let i = 0; top.return && i < BUDGET; i++) top = top.return;

        // 根から深さ優先で辿ります。stack に「これから調べるノード」を積み、pop() で 1 つずつ取り出します。
        const stack = [top];
        for (let budget = BUDGET; stack.length && budget > 0; budget--) {
            const fiber = stack.pop();
            const hit = holder(fiber, video);
            if (hit) return hit;
            if (fiber.sibling) stack.push(fiber.sibling); // 兄弟ノード
            if (fiber.child) stack.push(fiber.child);     // 子ノード
        }
        return null;
    }

    /**
     * 要素のうち、画面内に見えている部分の面積を求める（adapters/tiktok.js と同じ考え方）。
     * @param {Element} node 対象の要素
     * @returns {number} 見えている面積（ピクセル²）。見えていなければ 0
     */
    function area(node) {
        const rect   = node.getBoundingClientRect();
        const width  = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
        const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
        return width > 0 && height > 0 ? width * height : 0;
    }

    /**
     * Kick 用アダプターを生成する。
     * @returns {object} アダプターオブジェクト
     */
    function kick() {
        /** @type {HTMLVideoElement|null} 現在の video 要素 */
        let video   = null;
        /** @type {number} 最後に video を探した時刻 */
        let checkAt = -Infinity;

        /** @type {object|null} IVS プレーヤーの実体（React の中から探し出したもの） */
        let core     = null;
        /** @type {number} 次に実体を探してよい時刻 */
        let searchAt = -Infinity;
        /** @type {number} 実体を探して見つからなかった回数（探し直す間隔を延ばすのに使います） */
        let misses   = 0;
        /** @type {number} 最後に IVS 自身の自動加速を無効化した時刻 */
        let tamedAt  = -Infinity;

        /** @type {boolean} IVS が映像に差し込んだ広告を流している最中か */
        let adBreak = false;
        /** @type {string} 最後に見た IVS の再生セッションの ID。変わったら広告の印を捨てます */
        let session = '';

        /**
         * @type {object|string|null} 最後に見た再生ソース（srcObject、無ければ currentSrc）。
         * IVS の実体が見つからないときに、配信の切り替わりに気付くために使います（DAZN・TikTok と同じ）。
         */
        let source = null;
        /** @type {number} 再生ソースが入れ替わった回数 */
        let swaps  = 0;

        /**
         * @type {number} 映像の時刻と再生位置のずれ（秒）の推定。「映像の時刻 ＝ 再生位置 ＋ offset」。
         * まだ推定していなければ NaN です（lag() を参照）。
         */
        let offset = NaN;

        /**
         * @type {boolean} video が waiting を出してから playing を出すまでか（シークによるものを除く）。
         * 詰まっている間は遅延が伸び続けるので、それを「巻き戻して見ている」と取り違えないために使います
         * （stalled() を参照）。
         */
        let stuck = false;

        /**
         * @type {boolean} シークを始めてから、次に再生が始まる（playing）までか。
         * シークの後の waiting や IVS の Buffering は、詰まりではなくシークの続きなので、この間は数えません。
         * 数えると、巻き戻した直後の遅延を新しい基準にしてしまい、巻き戻しに気付けなくなるためです。
         */
        let seekPending = false;

        /** @type {boolean} 直前の measure() が「詰まっている」と判断したか（明けたときに記録をやり直すため） */
        let held = false;

        /** @type {boolean} このプレーヤーでコントロールバーを 1 度でも見つけたか（host() を参照） */
        let barSeen = false;

        // --- 読み込み中のまま止まったときの復帰（heal() を参照）で使う状態 ---
        // 試行回数（tries）などは forget() では消しません。読み込み直すと再生セッションが変わり、
        // inject.js が reset() として forget() を呼ぶためです。そこで回数を 0 に戻すと
        // 「読み込み直す → また止まる → また読み込み直す」を際限なく繰り返せてしまいます（Twitch と同じ考え方です）。

        /** @type {number} 止まっていないかを最後に確かめた時刻 */
        let pollAt   = -Infinity;
        /** @type {number} 読み込み中のまま再生位置が進まなくなった時刻。止まっていなければ NaN */
        let stallAt  = NaN;
        /** @type {number} 止まり始めたときの再生位置（秒） */
        let stallPos = NaN;
        /** @type {number} 最後に復帰を試みた時刻 */
        let healAt   = -Infinity;
        /** @type {number} 今回の異常で復帰を試みた回数 */
        let tries    = 0;
        /** @type {string} 最後に試した手（'seek' か 'reload'）。シークし直しを 2 回続けないために使います */
        let lastTry  = '';
        /** @type {number} 正常な再生が続き始めた時刻。途切れていれば NaN */
        let goodAt   = NaN;
        /**
         * @type {boolean} この <video> で、1 度でも正常に再生できたか。
         * 再生が始まる前（ページを開いた直後の読み込みや、配信の前に流れる広告の裏で待っている間）の
         * Buffering は「止まった」ものではないので、復帰の対象にしません。
         */
        let played   = false;

        /**
         * コントロールバーが取り除かれている間、バッジを預けておく入れ物。
         * ページには入れないので、中のバッジは見えません（host() を参照）。
         */
        const stash = document.createElement('div');

        /** 遅延を追跡し、巻き戻し視聴中かどうかを判定する道具。 */
        const latency = tracker();

        /**
         * media() / status() の結果の入れ物。制御ループから頻繁に呼ばれるので、
         * 呼ぶたびに作らず中身だけ書き換えて返します。
         */
        const current = { id: '', live: false };
        const stat    = { latency: NaN, atHead: true };

        /** 広告の始まり・終わりの合図を受け取る関数（登録と解除で同じものを渡すため、固定しておきます）。 */
        const adOn  = () => { adBreak = true; };
        const adOff = () => { adBreak = false; };

        /**
         * IVS プレーヤーに、広告の合図を受け取る関数を登録する／外す。
         * @param {object} target IVS プレーヤーの実体
         * @param {boolean} on true なら登録、false なら解除
         * @returns {void}
         */
        function listen(target, on) {
            const bind = on ? 'addEventListener' : 'removeEventListener';
            for (const type of AD_ON) safeCall(target, bind, null, type, adOn);
            for (const type of AD_OFF) safeCall(target, bind, null, type, adOff);
        }

        /**
         * つかんでいる IVS プレーヤーの実体を手放す。
         * 登録した広告の合図の受け取りを外し、広告の印も捨てます（新しい実体で改めて受け取るため）。
         * 破棄された実体からは外しません（受け取り口ごと消えており、外そうとすると警告が出るためです）。
         * @returns {void}
         */
        function drop() {
            try {
                if (core && !deleted(core)) listen(core, false);
            } catch { }
            core    = null;
            adBreak = false;
            tamedAt = -Infinity;
        }

        /**
         * IVS プレーヤーの実体を返す（無ければ、間隔を守って探す）。
         *
         * つかんでいる実体が今の <video> を再生していなければ（チャンネルを移って作り直された、
         * 破棄された、など）手放して探し直します。
         * @returns {object|null} 実体。見つからなければ null
         */
        function player() {
            if (core && !owns(core, video)) drop();
            if (core || !video) return core;

            const now = performance.now();
            if (now < searchAt) return null;

            let found = null;
            try { found = search(video); } catch { found = null; }
            if (!found) {
                misses += 1;
                searchAt = now + Math.min(SEARCH_MS * 2 ** (misses - 1), SEARCH_MAX_MS);
                return null;
            }

            core   = found;
            misses = 0;
            listen(core, true);
            return core;
        }

        /**
         * IVS プレーヤーの実体のメソッドを安全に呼び出す。
         * @param {string} name 呼び出すメソッド名
         * @param {*} fallback 呼べなかった場合に返す値
         * @param {...unknown} args 渡す引数
         * @returns {*} 戻り値、または fallback
         */
        const ask = (name, fallback, ...args) => safeCall(player(), name, fallback, ...args);

        /**
         * 再生が詰まり始めたとき（waiting）。シークの最中・直後は詰まりとして扱いません。
         * @returns {void}
         */
        const onWaiting = () => {
            if (!seekPending && video && !video.seeking) stuck = true;
        };

        /**
         * 再生が始まったとき（playing）。詰まりとシークの印を消します。
         * 詰まりが明けたときの記録のやり直しは、measure() が行います。
         * @returns {void}
         */
        const onPlaying = () => {
            stuck       = false;
            seekPending = false;
        };

        /**
         * シークが始まったとき（seeking）。
         * 詰まっている最中にシークした場合、その後の遅延の増減はシークによるものなので、詰まりの印も消します。
         * @returns {void}
         */
        const onSeeking = () => {
            seekPending = true;
            stuck       = false;
        };

        /**
         * 再生が詰まっているかどうか。
         *
         * video の waiting に加えて、IVS の状態が Buffering のときも詰まりとみなします。
         * IVS はデータが届かずに止まると <video> を一時停止（pause）させるため、waiting が出ないことがあるからです
         * （2026 年 11 月の実測で、データが 10 秒ほど届かなかったとき、<video> は一時停止の状態になりました）。
         * シークの最中・直後は、詰まっていても数えません（seekPending を参照）。
         * @returns {boolean} 詰まっていれば true
         */
        function stalled() {
            if (seekPending) return false;
            return stuck || ask('getState', '') === 'Buffering';
        }

        /** video 要素に登録するイベントと、その処理の対応表。 */
        const VIDEO_EVENTS = [['waiting', onWaiting], ['playing', onPlaying], ['seeking', onSeeking]];

        /**
         * video 要素へのイベント登録／解除をまとめて行う。
         * @param {HTMLVideoElement|null} node 対象の video 要素
         * @param {boolean} on true なら登録、false なら解除
         * @returns {void}
         */
        function wire(node, on) {
            if (!node) return;
            const bind = on ? 'addEventListener' : 'removeEventListener';
            for (const [type, handler] of VIDEO_EVENTS) node[bind](type, handler);
        }

        /**
         * 覚えていた遅延の情報を忘れる。配信が切り替わったとき（inject.js が reset() として呼びます）と、
         * video 要素が入れ替わったときに呼びます。
         * @returns {void}
         */
        function forget() {
            latency.reset();
            offset      = NaN;
            stuck       = false;
            seekPending = false;
            held        = false;
        }

        /**
         * 本編の video を探す。毎フレーム呼ばれます。
         *
         *   1) kick.com の本編（id="video-player"）があれば、それを使います。
         *   2) 無ければ（player.kick.com など）、広告の <video> を除いて、画面に映っている面積が
         *      いちばん大きいものを選びます。止まっているものは面積を半分に見積もります。
         * 探し直しは、つかんでいる video がページから外れたときと、RECHECK_MS ごとだけです。
         * @returns {HTMLVideoElement|null} 見つかった video 要素
         */
        function find() {
            const now = performance.now();
            if (video?.isConnected && now - checkAt < RECHECK_MS) return video;
            checkAt = now;

            let next = document.getElementById(MAIN_ID);
            if (!(next instanceof HTMLVideoElement)) {
                next = null;
                let size = 0;
                for (const node of document.querySelectorAll('video')) {
                    if (node.matches(AD_VIDEO)) continue;
                    const value = area(node) * (node.paused ? 0.5 : 1);
                    if (value > size) { next = node; size = value; }
                }
                // 画面内に見えるものが無ければ、つかんでいる video を（まだページにあれば）使い続けます。
                next ??= video?.isConnected ? video : null;
            }

            // 入れ替わったら、イベントの登録を付け替え、前の video について覚えていたことを捨てます
            // （古い要素に登録を残すと、メモリを手放せないため）。
            if (next !== video) {
                wire(video, false);
                video = next;
                wire(video, true);
                drop();
                forget();
                misses   = 0;
                searchAt = -Infinity;
                barSeen  = false;
                // 復帰の見張りも、新しい video では「まだ再生していない」ところから始めます
                // （試行回数は残します。上の「復帰で使う状態」の説明を参照）。
                played   = false;
                stallAt  = NaN;
                goodAt   = NaN;
            }
            return video;
        }

        /**
         * 「今の時刻 − 再生中の映像の時刻」（秒）を求める。求められなければ NaN。
         *
         * ■ 映像の時刻
         *   IVS の getSyncTime() は、再生中の映像が配信元で記録された時刻（HLS のプログラム日時、
         *   1970 年からのミリ秒）を返します。Kick 自身も、これを再生位置の時刻として計測に使っています。
         *   この差がそのまま「現実の時刻から何秒遅れて見ているか」になり、巻き戻すとその分だけ大きくなります。
         *   （2026 年 11 月の実測で、最前線では IVS の getLiveLatency() とほぼ同じ値になり、20 秒巻き戻すと
         *     約 2 秒後に 20 秒増えました。getLiveLatency() は巻き戻しても 10 秒以上同じ値のままでした）
         *
         * ■ 1 秒刻みを補う
         *   getSyncTime() は 1 秒単位でしか変わらないため、そのまま引くと、遅延が 1 秒ごとに
         *   0〜1 秒の幅でのこぎり状に揺れます。そこで「映像の時刻 − 再生位置」のずれ（offset）を推定し、
         *   「再生位置 ＋ offset」を映像の時刻として使います。1 秒単位の値は本当の時刻より必ず小さいか等しいので、
         *   ずれの最大値が本当のずれに最も近く、1 秒ほど見ていれば 0.1 秒ほどの精度になります。
         *   ずれが刻みの幅（RESYNC）を超えて変わったときは、シーク・配信の切れ目・別の配信へ移ったとみなし、
         *   推定をやり直します。
         * @returns {number} 遅延（秒）。端末の時計のずれを含みます
         */
        function lag() {
            const sync = toNum(ask('getSyncTime', NaN));
            const at   = video?.currentTime ?? NaN;
            if (!(sync > 0) || !Number.isFinite(at)) {
                offset = NaN;
                return NaN;
            }

            const seen = sync / 1000 - at;
            if (!(Math.abs(seen - offset) <= RESYNC)) offset = seen; // 初回・別の時間軸へ移ったとき
            else if (seen > offset) offset = seen;                   // より本当のずれに近い値

            return Date.now() / 1000 - (at + offset);
        }

        /**
         * 遅延（秒）と、最前線にいるかを求める。3 つの求め方を、使えるものから順に試します。
         *
         *   1) 映像の時刻 … lag() の「今の時刻 − 再生中の映像の時刻」。巻き戻しにもすぐ追従します。
         *      端末の時計が大きくずれていて範囲（WALL_MIN〜WALL_MAX）の外になるときは使いません。
         *   2) IVS の getLiveLatency() … 最前線では 1) と同じ値です（巻き戻しには追従が遅れます）。
         *   3) バッファ … 「受信済みの末尾 − 再生位置」（TikTok と同じ）。IVS の実体が見つからないときの最後の手段です。
         *
         * 1) と 2) は tracker で巻き戻し視聴（DVR）を見分けます。端末の時計のずれは、比べる値の両方に
         * 同じだけ含まれるので、判定には影響しません。
         * 詰まっている間（stalled() を参照）は、伸び続ける遅延と比べないよう判定を止めて「最前線にいる」として返し、
         * 明けたときに記録をやり直します。詰まっていた分だけ最前線から遅れた位置を新しい基準にして、
         * 「巻き戻して見ている」と取り違えないためです（そこから先は、加速して遅れを取り戻すのが仕様です）。
         * 3) はバッファが溜まるだけで伸びる値なので、比べずに常に「最前線にいる」として返します（DAZN と同じ）。
         * @returns {{ latency: number, atHead: boolean }} 結果の入れ物（使い回します）
         */
        function measure() {
            let value = lag();
            if (!(value >= WALL_MIN && value <= WALL_MAX)) {
                const edge = toNum(ask('getLiveLatency', NaN));
                value = edge > 0 ? edge : NaN;
            } else {
                value = Math.max(0, value);
            }

            if (Number.isFinite(value)) {
                if (stalled()) {
                    held = true;
                    stat.latency = value;
                    stat.atHead  = true;
                    return stat;
                }
                if (held) {
                    held = false;
                    latency.reset();
                }
                return latency.read(value);
            }

            let edge = NaN;
            try {
                const ranges = video?.buffered;
                if (ranges?.length) edge = Math.max(0, ranges.end(ranges.length - 1) - video.currentTime);
            } catch {
                edge = NaN;
            }
            stat.latency = edge;
            stat.atHead  = true;
            return stat;
        }

        /**
         * 配信の前などに流れる Google IMA の広告（本編とは別の <video title="Advertisement">）が再生中かどうか。
         * そのあいだ本編が待っているのは止まっているからではないので、復帰の対象にしません。
         * @returns {boolean} 再生中なら true
         */
        function imaPlaying() {
            const ad = document.querySelector(`video${AD_VIDEO}`);
            return ad instanceof HTMLVideoElement && !ad.paused && !ad.ended;
        }

        /**
         * 正常に再生できているか（IVS の状態が Playing で、<video> がデータを持って進んでいるか）。
         * @returns {boolean} 正常なら true
         */
        const healthy = () => Boolean(video) && !video.paused && video.readyState >= 3
            && ask('getState', '') === 'Playing';

        /**
         * 読み込み中のくるくる表示が出たまま、復帰の対象になる状態かどうか。
         *
         * 次のすべてを満たすときだけ true です。
         *   1) この <video> で 1 度は正常に再生できた（played。再生が始まる前の読み込みは対象外）
         *   2) ライブ配信を流している（アーカイブ・クリップ・IVS が映像に差し込んだ広告の最中ではない。
         *      media() が最後に求めた判定をそのまま使います）
         *   3) IVS の状態が Buffering（Kick はこのとき画面にくるくる表示を出します）
         *   4) ユーザーが一時停止していない。IVS の isPaused() は、利用者が止めたときだけ true になります
         *      （Buffering のあいだは IVS が <video> を一時停止させるので、<video> の paused では見分けられません）
         *   5) 配信の前などに流れる IMA の広告が再生中ではない
         * IVS の実体が見つからないときは 3) で false になり、何もしません（打てる手が無いため）。
         * 再生位置が本当に進んでいないかは、heal() が時刻と位置を控えて確かめます。
         * @returns {boolean} 対象の状態なら true
         */
        function jammed() {
            if (!video || !played || !current.live) return false;
            if (ask('getState', '') !== 'Buffering') return false;
            if (ask('isPaused', true) !== false) return false;
            return !imaPlaying();
        }

        /**
         * シークし直す先（秒）を決める。
         *
         * ふつうは今の再生位置です（読み込み済みの範囲の中にあれば、そこからそのまま再生を続けられます）。
         * 再生位置が読み込み済みの範囲の外にあるとき（範囲の先へ飛んだシークが残っているときなど）は、
         * そこへシークし直しても終わらないので、最後の範囲の終わりの 1 秒手前にします。
         * 読み込み済みの範囲が 1 つも無ければ、今の再生位置のままにします。
         * @returns {number} シーク先（秒）。決められなければ NaN
         */
        function anchor() {
            try {
                const at     = video.currentTime;
                const ranges = video.buffered;
                if (!ranges.length) return at;
                for (let i = 0; i < ranges.length; i++) {
                    if (at >= ranges.start(i) && at <= ranges.end(i)) return at;
                }
                const last = ranges.length - 1;
                return Math.max(ranges.start(last), ranges.end(last) - 1);
            } catch {
                return NaN;
            }
        }

        /**
         * 復帰を 1 回試みる。
         *
         *   - 完了しないシークが残っていれば（isSeeking() が true）、今の再生位置へ seekTo() し直して終わらせます
         *     （位置の決め方は anchor() を参照）。読み込み直しでは消えないため、先にこちらを試します。
         *     ただし 2 回続けては試しません（シークし直しても戻らなかったのなら、原因は別にあるためです）。
         *   - それ以外は、今の再生ソース（getPath()）を load() で読み込み直し、setAutoplay(true) で再生を始めさせます。
         *     Kick 自身がエラーから立ち直るときと同じ手順で、最前線から再生し直します。トークンの期限が切れていれば
         *     IVS がエラーを出し、Kick 自身の再接続が新しいトークンで読み込み直します。
         * 再生ソースのアドレス（トークンを含みます）はログに出しません。
         * @param {number} n 今回が何回目の試行か（1 から始まる）
         * @returns {string} 何をしたかを表す短い文字列（デバッグログ用）
         */
        function attempt(n) {
            if (lastTry !== 'seek' && ask('isSeeking', false) === true) {
                const to = anchor();
                if (Number.isFinite(to)) {
                    lastTry = 'seek';
                    ask('seekTo', null, to);
                    return `seek #${n}`;
                }
            }

            const path = ask('getPath', '');
            if (typeof path !== 'string' || !path) return `giveup #${n}`;
            lastTry = 'reload';
            // 今の IVS は何も返しませんが、将来 Promise を返すようになっても、
            // 拒否されたときに未処理の警告が出ないよう受けておきます。
            const done = ask('load', null, path);
            if (typeof done?.catch === 'function') done.catch(() => { });
            ask('setAutoplay', null, true);
            return `reload #${n}`;
        }

        /**
         * 読み込み中のまま止まったプレーヤーを見張り、必要なら復帰を試みる。
         *
         * ■ すぐに手を出さない理由
         *   ふつうのバッファ切れは、データが届けば数秒で IVS 自身が再生に戻ります。そこへ割り込むと、
         *   届きかけていた分を捨てて読み込み直すことになるため、再生位置が HEAL_WAIT[0] だけ進まないときだけ動きます。
         *   以降も間隔を広げながら数回だけ試し、駄目なら諦めます（Twitch の heal() と同じ考え方です）。
         * 止まり始めたことに気付いただけのときは何も返しません。inject.js は、この関数が文字列を返すと
         * 速度と音量の横取りを解いて学習内容を捨てるため、ふつうのバッファ切れのたびにそうさせないためです。
         * @returns {string|null} 試行したときだけ、その内容を表す文字列
         */
        function heal() {
            const now = performance.now();
            if (now - pollAt < HEAL_POLL_MS) return null;
            pollAt = now;

            // --- 止まっていない ---
            if (!jammed()) {
                stallAt = NaN;
                if (!healthy()) { goodAt = NaN; return null; }

                // 正常な再生が続いたら、今回の異常のことは忘れます。
                played = true;
                if (Number.isNaN(goodAt)) goodAt = now;
                if (now - goodAt >= HEAL_CLEAR_MS) { tries = 0; lastTry = ''; healAt = -Infinity; }
                return null;
            }

            // --- 読み込み中のまま ---
            goodAt = NaN;

            // 止まり始めた時刻と位置を控えます。位置が動いていれば止まってはいないので、そこから数え直します。
            // `!(差 <= 幅)` と書くのは、位置が NaN のときも「数え直す」側へ倒すためです。
            const at = video.currentTime;
            if (Number.isNaN(stallAt) || !(Math.abs(at - stallPos) <= HEAL_MOVED)) {
                stallAt  = now;
                stallPos = at;
                return null;
            }

            if (tries >= HEAL_WAIT.length) return null;       // 試せる回数を使い切った
            if (now - stallAt < HEAL_WAIT[0]) return null;    // まだ自然に戻るかもしれない
            if (now - healAt < HEAL_WAIT[tries]) return null; // 前回の試行から間を空ける

            healAt = now;
            tries += 1;
            return attempt(tries);
        }

        return {
            // Kick のライブのプレーヤーには速度変更のメニューがありません（歯車のメニューは画質だけです）。
            // IVS 自身が速度を書き換えても、横取りした側で受け止めて Slipstream Live の判断を優先します。
            respectUserRate: false,

            // IVS は Twitch のプレーヤーと同じ系統で、バッファの隙間を自分で飛び越えて再生を続けます
            // （再生を始めるときに隙間の先へ移る処理と、飛び越えた回数・秒数の記録がプレーヤーにあります）。
            // そのため Twitch と同じ 5 秒までは、つながっているとみなします。
            gap: 5,

            badgeClass: '',
            badgeStyle: BADGE_STYLE_PLAIN,

            reset: forget,

            /**
             * 読み込み中のまま止まったプレーヤーを立て直す。
             * Twitch とこのアダプターにだけある任意のメソッドで、設定の「読み込み中のまま止まったら自動復帰する」
             * （recover）がオンのときだけ、inject.js がライブ判定より前に呼びます。
             */
            heal,

            /**
             * プレーヤーの外枠要素を返す（コントロールバーが見つからないときの、バッジの表示位置の基準）。
             * video の親（kick.com では div.relative.aspect-video、player.kick.com では
             * div.aspect-video-responsive）が、コントロールも含むプレーヤーの枠です。
             * @returns {Element|null}
             */
            root: () => video?.parentElement ?? null,

            /**
             * 現在の <video> 要素を返す。
             *
             * ついでに、IVS 自身の自動加速を無効化します（等倍に固定。Twitch と同じ）。
             * 定期的にやり直すのは、プレーヤーが作り直されたときなどに設定が戻ることがあるためです。
             * @returns {HTMLVideoElement|null}
             */
            video() {
                const node = find();
                const now  = performance.now();
                if (node && now - tamedAt >= TAME_MS) {
                    tamedAt = now;
                    ask('setLiveSpeedUpRate', null, 1);
                }
                return node;
            },

            /**
             * 現在再生中のメディアの情報を返す。
             *
             * ライブ判定の条件は 3 つすべてを満たすこと：
             *   1) 再生ソースが設定されている（何も読み込んでいない <video> は対象外）
             *   2) IVS が映像に差し込んだ広告を流していない
             *   3) 動画の長さが ENDLESS 以上（ライブは Infinity。読み込み中で不明な場合も含む）
             *
             * id は IVS の再生セッションの ID です。チャンネルを移ったり読み込み直したりするたびに変わるので、
             * 「別の配信になった」合図になります。チャンネルの中のタブ（概要・ビデオなど）を移っても、
             * 上の本編は同じ配信を流し続けるため、URL は id に含めません。
             * IVS の実体が見つからないときは、DAZN・TikTok と同じく「パス#再生ソースの入れ替わり回数」にします。
             * @returns {{ id: string, live: boolean }}
             */
            media() {
                const node = video;

                const src = node ? (node.srcObject ?? node.currentSrc) : null;
                if (src !== source) {
                    source = src;
                    swaps += 1;
                }

                const id = String(ask('getSessionId', '') ?? '');
                if (id !== session) {
                    session = id;
                    adBreak = false; // 新しいセッションに、前の配信の広告の印を持ち越しません
                }

                const duration = node?.duration ?? NaN;
                current.id   = id ? `${id}#${swaps}` : `${location.pathname.toLowerCase()}#${swaps}`;
                current.live = node !== null && Boolean(src) && !adBreak
                    && (Number.isNaN(duration) || duration >= ENDLESS);
                return current;
            },

            /**
             * 現在の遅延と、ライブ最前線にいるかを返す（求め方は measure() を参照）。
             * @returns {{ latency: number, atHead: boolean }}
             */
            status: measure,

            /**
             * このサイトが必要とするバッファの目安（秒）を返す。
             * IVS は Twitch のプレーヤーと同じ系統なので、Twitch と同じく
             * 低遅延モードなら約 2 秒、通常モードなら約 4 秒とします。
             * @returns {number}
             */
            needs: () => (ask('isLiveLowLatency', true) === true ? 2 : 4),

            /**
             * バッジを差し込みたい場所（コントロールバー下段の、左側のボタンが並ぶ箱）を返す。
             *
             * 左側には、再生／一時停止・音量・経過時間・LIVE が並んでいます。
             * プレーヤーの枠の中の再生アイコンから上へたどり、音量の部品も含む最初の祖先を
             * 「ボタンが並ぶ箱」とみなして、その末尾（LIVE の右隣）にバッジを並べます。
             *   - 画面に出ていないアイコン（player.kick.com の狭い画面用の作りなど）は飛ばします。
             *   - 再生アイコンを 2 つ以上含む箱は、ボタンが並ぶ箱ではないので選びません。
             *
             * コントロールバーが無いとき：
             *   このプレーヤーで 1 度でも見つけていれば、隠れている（取り除かれている）だけなので、
             *   ページに入れない入れ物（stash）を返します。バッジはそこへ移されて見えなくなり、
             *   本体は 0.1 秒ごとに置き場所を確かめ直すので、コントロールバーが現れるとすぐに戻ります。
             *   まだ 1 度も見つけていなければ、作りが変わって見つけられない場合に備えて null を返し、
             *   本体にプレーヤーの左上へ浮かべる枠を用意させます（マウスを動かしてコントロールバーが
             *   現れれば、以後はそちらへ移ります）。
             * @returns {Element|null}
             */
            host() {
                const box = video?.parentElement;
                if (!box) return null;

                for (const icon of box.querySelectorAll(PLAY)) {
                    if (!icon.getClientRects().length) continue;
                    for (let node = icon.parentElement, depth = 0; node && node !== box && depth < CLIMB;
                        node = node.parentElement, depth++) {
                        if (!node.querySelector(VOLUME)) continue;
                        if (node.querySelectorAll(PLAY).length > 1) break;
                        barSeen = true;
                        return node;
                    }
                }
                return barSeen ? stash : null;
            },
        };
    }

    // このアダプターを「kick」という ID で登録する。
    registerSite('kick', HOST, kick);
})();
