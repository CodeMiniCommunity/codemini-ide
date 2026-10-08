// ==========================================
// git.js (Source Control sidebar)
// ==========================================
// Wires up the "Source Control" entry that already sits, non-functional, in
// the activity bar's overflow dropdown (#menuSource, see script.js's
// activityMeta/dropIds - it's one of four decorative stubs: Agent Mini, Live
// Collab, Database, Source Control). Adapted from a fuller reference
// implementation (branches/stash/history/GitHub remote), restyled to
// CodeMini's own theme tokens and cut down to what actually fits a
// browser-only, offline-first IDE with no real git binary: local commits,
// branches (with real checkout - switching branches rewrites the working
// files), stash, a real diff viewer, and a deliberately scoped-down GitHub
// remote (push/pull via the real REST API, no gists/issues/stars/clone-tree
// replace). Follows stacks.js's own architecture as closely as possible
// (self-built sidebar, per-window state registry, resizer preservation,
// one guarded <style> injection) since it's the closest existing analog.
//
// Data model: each database (a profile's root db, or a workspace's own db -
// so "repository" maps 1:1 onto CodeMini's existing "workspace" concept)
// gets its own independent repo state in localStorage, keyed by db name:
//   codemini_git_config_<dbName>  - { currentBranch, authorName }
//   codemini_git_repo_<dbName>    - { objects: { <sha>: <commit> }, refs: { <branch>: <sha|null> }, stash: [...] }
//   codemini_git_staged_<dbName>  - [ path, ... ]
//
// Commits form a real DAG, same shape as actual git:
//   - `objects` is a single flat, content-addressed store shared by every
//     branch. A commit's id IS the sha of its own content (message, author,
//     timestamp, parents, files) via gitHashCommit - two branches that share
//     history point at the exact same object, not a copy of it, so branching
//     is O(1) (one ref write) instead of duplicating a commit array, and the
//     DAG itself is representable (a commit knows its parents, so ancestry,
//     merge-base and fast-forward detection are all real graph walks, not
//     approximations over flat per-branch lists).
//   - `refs[branchName]` is just a pointer: the sha of the commit that branch
//     currently points at, or null for a branch with no commits yet. This is
//     what a real git branch actually is - not a container that owns its own
//     commit history.
//   - A commit's `parents` array is empty for a root commit, has one entry
//     for a normal commit, and two for a merge commit (first parent = the
//     branch that was merged into, second = the branch that was merged in) -
//     exactly mirroring real git's parent-ordering convention.
//   - "The tree at a commit" is still reconstructed by replaying that
//     commit's ancestor chain in order (see gitComputeHeadTree) - nothing
//     redundant is stored, exactly like real git's own snapshot-via-deltas
//     model conceptually (this app stores full file content per change
//     rather than binary deltas, which is a real, documented limitation -
//     see the packfile/delta-compression note - but the DAG and addressing
//     are real).

// --- Storage helpers ---------------------------------------------------
function gitStorageKey(dbName, suffix) { return `codemini_git_${suffix}_${dbName}`; }

function getGitConfig(dbName) {
    try {
        const raw = localStorage.getItem(gitStorageKey(dbName, 'config'));
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { currentBranch: 'main', authorName: 'You' };
}
function saveGitConfig(dbName, config) {
    localStorage.setItem(gitStorageKey(dbName, 'config'), JSON.stringify(config));
}
// Returns the repo in the current { objects, refs, stash } shape, transparently
// migrating the old { branches: { name: { commits: [...] } } } shape the very
// first time an old repo is read (see gitMigrateLegacyRepoShape) so existing
// local repos/commits from before this change are never silently dropped.
// --- Commit-object storage (IndexedDB, not localStorage) --------------------
// repo.objects used to be part of the same localStorage JSON blob as
// everything else, which meant the ENTIRE commit history's full file
// content, for every branch, forever, competed for the same ~5-10MB
// per-origin ceiling as every other site's localStorage - a repo with a few
// hundred real commits could overflow it outright (this was flagged as the
// single highest-leverage fix on the original gap list). Objects now live in
// their own IndexedDB store ('gitobjects', added to this app's existing
// per-workspace database - see ensureCodeMiniSchema in app.js) inside the
// SAME database as that workspace's files, so it shares that workspace's own
// storage quota (typically hundreds of MB to low GB, not a fixed 5-10MB) and
// stays scoped/deleted together with it.
//
// Every one of git.js's existing functions still reads/writes repo.objects
// as a plain, synchronous JS object (repo.objects[sha], repo.objects[sha] =
// x) - converting all ~44 call sites to await an async lookup for every
// single commit access was neither necessary nor safe to do in one pass.
// Instead: gitObjectCache holds one plain object per open database, hydrated
// from IndexedDB once (gitHydrateObjectCache, awaited wherever a
// database/window/workspace first becomes active), and getGitRepo hands out
// a REFERENCE to that same live cache object as repo.objects - so an
// existing `repo.objects[sha] = x` write is instantly visible to every other
// synchronous reader without any of them needing to change. saveGitRepo
// (already called after every write, by every existing function) is what
// flushes any objects new since the last save out to IndexedDB - the async
// part of this design is entirely contained in the hydrate/flush boundary,
// not spread across the 44 read/write sites in between.
const gitObjectCache = new Map(); // dbName -> plain object { sha: commit }
const gitObjectCacheKnownShas = new Map(); // dbName -> Set of shas already confirmed written to IndexedDB, so saveGitRepo only ever flushes what's actually new
function gitLoadAllObjectsFromDB(database) {
    return new Promise((resolve) => {
        try {
            const tx = database.transaction('gitobjects', 'readonly');
            tx.objectStore('gitobjects').getAll().onsuccess = (e) => resolve(e.target.result || []);
            tx.onerror = () => resolve([]);
        } catch (e) { resolve([]); }
    });
}
function gitPutObjectsToDB(database, entries) {
    // entries: [{ sha, commit }, ...] - all written in ONE transaction, since
    // this can be called with hundreds of objects at once (a pull, a
    // migration, a rebase) and IndexedDB overhead per transaction dwarfs
    // per-put overhead within one.
    return new Promise((resolve) => {
        if (!entries.length) { resolve(); return; }
        try {
            const tx = database.transaction('gitobjects', 'readwrite');
            entries.forEach(({ sha, commit }) => tx.objectStore('gitobjects').put({ sha, commit }));
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch (e) { resolve(); }
    });
}
// Populates gitObjectCache[dbName] from IndexedDB. Safe to call repeatedly -
// a database already hydrated in this session is a no-op, so callers don't
// need to track hydration state themselves; they just await this before
// touching repo.objects the first time in a given render/action.
async function gitHydrateObjectCache(database) {
    const dbName = database.name;
    if (gitObjectCache.has(dbName)) return;
    const rows = await gitLoadAllObjectsFromDB(database);
    const plain = {};
    const known = new Set();
    rows.forEach(row => { plain[row.sha] = row.commit; known.add(row.sha); });
    gitObjectCache.set(dbName, plain);
    gitObjectCacheKnownShas.set(dbName, known);
}
function getGitRepo(dbName) {
    let repo = null;
    try {
        const raw = localStorage.getItem(gitStorageKey(dbName, 'repo'));
        if (raw) repo = JSON.parse(raw);
    } catch (e) {}
    // objects is never read from this localStorage blob (old saves may still
    // have one on disk from before this change - see gitMigrateLegacyRepoShape
    // and the one-time migration-of-the-migration below, which is the only
    // place an old blob's embedded objects are ever consulted, and only once).
    if (!repo) repo = { refs: { main: null }, tags: {}, stash: [] };
    if (repo.branches && !repo.objects && !gitObjectCache.has(dbName)) {
        // Legacy shape from before the DAG rewrite: migrate ref/commit
        // structure as before, but objects now go to the cache (and get
        // flushed to IndexedDB on the next saveGitRepo) instead of back into
        // the localStorage blob.
        const migrated = gitMigrateLegacyRepoShape(repo);
        gitObjectCache.set(dbName, migrated.objects);
        gitObjectCacheKnownShas.set(dbName, new Set()); // nothing confirmed in IndexedDB yet - saveGitRepo will flush all of it
        repo = { refs: migrated.refs, tags: {}, stash: migrated.stash };
        saveGitRepoMetaOnly(dbName, repo);
    } else if (repo.objects && !gitObjectCache.has(dbName)) {
        // An even older on-disk blob that still has objects embedded from
        // before THIS change (objects-in-IndexedDB) - seed the cache from it
        // once, then stop carrying objects in the localStorage copy at all.
        gitObjectCache.set(dbName, repo.objects);
        gitObjectCacheKnownShas.set(dbName, new Set()); // not yet confirmed in IndexedDB - flush everything on next save
    }
    if (!gitObjectCache.has(dbName)) { gitObjectCache.set(dbName, {}); gitObjectCacheKnownShas.set(dbName, new Set()); }
    if (!repo.refs) repo.refs = { main: null };
    if (!repo.tags) repo.tags = {};
    if (!repo.stash) repo.stash = [];
    repo.objects = gitObjectCache.get(dbName); // live reference - writes through this are visible to every other caller immediately
    return repo;
}
// Persists everything EXCEPT objects to the localStorage blob (refs, tags,
// stash) - used internally right after a legacy-shape migration, before any
// IndexedDB flush has happened, so the tiny ref/tag/stash metadata is never
// lost even if the (larger, async) object flush hasn't run yet.
function saveGitRepoMetaOnly(dbName, repo) {
    localStorage.setItem(gitStorageKey(dbName, 'repo'), JSON.stringify({ refs: repo.refs, tags: repo.tags, stash: repo.stash }));
}
// Persists refs/tags/stash to localStorage (small, bounded, unchanged from
// before) and flushes any objects new since the last save to IndexedDB
// (fire-and-forget - callers already don't await saveGitRepo today, and
// making 44 call sites start awaiting it would be exactly the invasive,
// unnecessary rewrite this whole design avoids; the in-memory cache is
// already updated synchronously by the time this runs, which is what every
// reader actually depends on - IndexedDB durability catching up a moment
// later is the same "eventually persisted" model localStorage itself
// provided no stronger guarantee than anyway).
function saveGitRepo(dbName, repo) {
    saveGitRepoMetaOnly(dbName, repo);
    const known = gitObjectCacheKnownShas.get(dbName) || new Set();
    const toFlush = [];
    for (const sha in repo.objects) {
        if (!known.has(sha)) { toFlush.push({ sha, commit: repo.objects[sha] }); known.add(sha); }
    }
    gitObjectCacheKnownShas.set(dbName, known);
    if (toFlush.length && typeof db !== 'undefined' && db && db.name === dbName) {
        gitPutObjectsToDB(db, toFlush);
    }
    // db.name !== dbName (or db undefined) means this save is for a database
    // that isn't the currently-open one - shouldn't normally happen since
    // every caller operates on the active db, but if it ever does, the
    // objects stay correctly in the in-memory cache and get flushed on the
    // next save that DOES run against the matching open database, rather
    // than silently writing to the wrong one or throwing.
}
// --- Reflog ---------------------------------------------------------------
// A dedicated ledger of every time a branch ref actually moved - distinct
// from gitLog (the human-readable activity feed used for the Config tab's
// export/audit trail, which redacts content and only optionally carries a
// truncated details blob). The reflog exists for exactly one job real git's
// own reflog does: recovering a commit that's no longer reachable from any
// branch, after a hard reset, a rebase, an amend, or a branch delete/rename -
// so it always records the FULL sha on both sides of the move, never a
// shortened or best-effort version, and every entry looks the same
// regardless of which operation caused it.
const GIT_REFLOG_MAX = 100; // per branch, mirroring real git's own reflog expiry (gc.reflogExpire) rather than keeping this unbounded forever
function gitReflogKey(dbName, branch) { return gitStorageKey(dbName, `reflog_${branch}`); }
function gitGetReflog(dbName, branch) {
    try {
        const raw = localStorage.getItem(gitReflogKey(dbName, branch));
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
}
// Every reflog-tracked branch name for a repo, so the Reflog view can list
// entries across all of them (including a branch that's since been deleted -
// its reflog key is intentionally left in place rather than deleted
// alongside the branch, exactly why this is useful: real git keeps a deleted
// branch's reflog around too, since "I deleted the wrong branch" is one of
// the exact situations a reflog exists to recover from).
function gitReflogBranches(dbName) {
    const prefix = 'codemini_git_reflog_';
    const suffix = `_${dbName}`;
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix) && key.endsWith(suffix)) {
            names.push(key.slice(prefix.length, key.length - suffix.length));
        }
    }
    return names;
}
// The single function every real ref move goes through - callers pass what
// the ref is becoming and why; this handles both the actual assignment and
// recording it, so no call site can move a ref without it being recoverable.
// Does NOT call saveGitRepo itself - callers already do their own save
// alongside other changes in the same operation (new commit objects, staged
// paths, etc.), and forcing a second write here would be redundant.
function gitMoveRef(dbName, repo, branchName, newSha, reason) {
    const oldSha = Object.prototype.hasOwnProperty.call(repo.refs, branchName) ? repo.refs[branchName] : null;
    repo.refs[branchName] = newSha;
    if (oldSha === newSha) return; // no-op move (e.g. re-affirming an already-correct ref) - nothing happened, nothing to log
    let entries = gitGetReflog(dbName, branchName);
    entries.push({ id: gitNewId('rl'), ts: Date.now(), branch: branchName, from: oldSha, to: newSha, reason });
    if (entries.length > GIT_REFLOG_MAX) entries = entries.slice(-GIT_REFLOG_MAX);
    localStorage.setItem(gitReflogKey(dbName, branchName), JSON.stringify(entries));
}
// Points a branch back at a specific reflog entry's "from" (or "to") sha -
// real git's `git reset --hard HEAD@{n}` in spirit, but scoped to just
// moving the ref (the caller decides separately whether to also sync the
// working tree, same division of responsibility gitResetToCommit already
// has between its soft/mixed/hard modes).
function gitRecoverRef(dbName, branchName, sha) {
    const repo = getGitRepo(dbName);
    if (!repo.objects[sha]) return { error: 'That commit no longer exists in this repository.' };
    gitMoveRef(dbName, repo, branchName, sha, `Recovered from reflog to ${gitShortSha(sha)}`);
    saveGitRepo(dbName, repo);
    return { ok: true };
}
function getStagedPaths(dbName) {
    try {
        const raw = localStorage.getItem(gitStorageKey(dbName, 'staged'));
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
}
function saveStagedPaths(dbName, paths) {
    localStorage.setItem(gitStorageKey(dbName, 'staged'), JSON.stringify(paths));
}

// --- Small utilities -----------------------------------------------------
function gitEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function gitRelativeTime(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
}
function gitNewId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function gitStatusBadge(status) {
    const map = {
        added: { l: 'U', c: 'var(--color-success)', title: 'Untracked' },
        modified: { l: 'M', c: 'var(--color-warning)', title: 'Modified' },
        deleted: { l: 'D', c: 'var(--color-danger)', title: 'Deleted' }
    };
    const m = map[status] || map.modified;
    return `<span class="git-status-badge" style="color:${m.c}; border-color:${m.c};" title="${m.title}">${m.l}</span>`;
}

// --- Filesystem access (mirrors the get-all-then-build-path-map pattern
// already used in preview.js/app.js, but self-contained here since those
// helpers are private to their own files) ---------------------------------
function gitGetAllFiles(database) {
    return new Promise((resolve) => {
        try {
            const tx = database.transaction('filesystem', 'readonly');
            tx.objectStore('filesystem').getAll().onsuccess = (e) => resolve(e.target.result || []);
            tx.onerror = () => resolve([]);
        } catch (e) { resolve([]); }
    });
}
function gitPutFile(database, record) {
    return new Promise((resolve) => {
        try {
            const tx = database.transaction('filesystem', 'readwrite');
            tx.objectStore('filesystem').put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch (e) { resolve(); }
    });
}
function gitBuildPathMap(allFiles) {
    const byId = new Map(allFiles.map(f => [f.id, f]));
    const cache = new Map();
    function getPath(f) {
        if (cache.has(f.id)) return cache.get(f.id);
        const parent = byId.get(f.parentId);
        const path = parent ? getPath(parent) + '/' + f.name : '/' + f.name;
        cache.set(f.id, path);
        return path;
    }
    allFiles.forEach(f => getPath(f));
    return cache;
}
// Working tree = every real (non-locked) file currently in the database,
// keyed by its full path. Locked/password-protected files are excluded
// entirely from tracking, staging, diffing and checkout - Source Control
// never reads or overwrites their content.
async function gitGetWorkingTree(database) {
    const allFiles = await gitGetAllFiles(database);
    const pathMap = gitBuildPathMap(allFiles);
    const tree = new Map();
    allFiles.forEach(f => {
        if (f.type !== 'file' || f.isLocked) return;
        tree.set(pathMap.get(f.id), { id: f.id, name: f.name, content: f.content || '', encoding: f.encoding || 'text' });
    });
    return tree;
}
// Ensures a nested folder path exists under the workspace root, creating any
// missing segments, and returns the id of the deepest folder. Used when a
// checkout/discard/merge needs to recreate a file whose folder no longer
// exists. Does its own small transaction per missing folder (sequentially
// awaited) rather than reusing a caller's open transaction - IndexedDB
// transactions auto-commit once idle, so awaiting inside one is unsafe.
async function gitEnsureFolderPath(database, dirPath) {
    // The top-level sentinel differs by database: the outer profile db's own
    // top level really is 'root', but a workspace's own separate database
    // uses that workspace's own id instead (see enterWorkspace in app.js,
    // which sets folderStack[0] to the workspace's own record when you enter
    // it) - folderStack[0].id is what the rest of the app already treats as
    // "top level for whichever db is currently active", so it's read here
    // rather than assuming the literal string.
    const rootId = (typeof folderStack !== 'undefined' && folderStack[0] && folderStack[0].id) || 'root';
    if (!dirPath || dirPath === '/') return rootId;
    const parts = dirPath.split('/').filter(Boolean);
    let parentId = rootId;
    let allFiles = await gitGetAllFiles(database);
    for (const part of parts) {
        let existing = allFiles.find(f => f.parentId === parentId && f.name === part && (f.type === 'folder' || f.type === 'workspace'));
        if (!existing) {
            existing = { id: gitNewId('f'), parentId, name: part, type: 'folder', timestamp: Date.now() };
            await gitPutFile(database, existing);
            allFiles.push(existing);
        }
        parentId = existing.id;
    }
    return parentId;
}
// Makes the actual filesystem match targetTree (Map<path, {content,encoding,name}>)
// exactly - creates/updates every file it specifies and removes any currently
// tracked file that isn't in it. This one function powers every action that
// changes the working tree: discard, branch checkout, merge, stash pop, and
// restore-to-commit, so "what does discard do" and "what does switching
// branches do" are answered by the same, single, well-tested code path.
async function gitApplyTree(database, targetTree) {
    const allFiles = await gitGetAllFiles(database);
    const pathMap = gitBuildPathMap(allFiles);
    const pathToFile = new Map();
    allFiles.forEach(f => { if (f.type === 'file') pathToFile.set(pathMap.get(f.id), f); });

    // Pass 1: create any missing folders first (each a separate awaited
    // transaction) before opening the single write transaction below.
    const dirParentIds = new Map();
    for (const path of targetTree.keys()) {
        if (pathToFile.has(path)) continue;
        const dirPath = path.substring(0, path.lastIndexOf('/')) || '/';
        if (!dirParentIds.has(dirPath)) dirParentIds.set(dirPath, await gitEnsureFolderPath(database, dirPath));
    }

    // The workspace/profile root for this database - never a candidate for
    // pruning, whatever its real id is (see gitEnsureFolderPath for why this
    // isn't always the literal string 'root').
    const rootId = (typeof folderStack !== 'undefined' && folderStack[0] && folderStack[0].id) || 'root';

    // Pass 2: one write transaction for every add/update/remove.
    return new Promise((resolve) => {
        let tx;
        try { tx = database.transaction('filesystem', 'readwrite'); }
        catch (e) { resolve(); return; }
        const store = tx.objectStore('filesystem');

        // Folders whose contents might now be empty because a file inside them
        // (at any depth) is about to be deleted - checked and pruned below,
        // after every delete/put has been issued. Without this, gitApplyTree
        // only ever deleted files, never folders: switching branches, discarding,
        // restoring or pulling repeatedly left every now-childless folder behind
        // forever, silently littering the Explorer with empty directories.
        const foldersToCheck = new Set();
        pathToFile.forEach((f, path) => {
            if (f.isLocked) return;
            if (!targetTree.has(path)) {
                store.delete(f.id);
                let parentId = f.parentId;
                while (parentId && parentId !== rootId) {
                    foldersToCheck.add(parentId);
                    const parentFile = allFiles.find(x => x.id === parentId);
                    if (!parentFile) break;
                    parentId = parentFile.parentId;
                }
            }
        });
        targetTree.forEach((data, path) => {
            const existing = pathToFile.get(path);
            if (existing) {
                if (existing.isLocked) return;
                existing.content = data.content;
                existing.encoding = data.encoding || 'text';
                existing.timestamp = Date.now();
                store.put(existing);
            } else {
                const dirPath = path.substring(0, path.lastIndexOf('/')) || '/';
                store.put({
                    id: gitNewId('gf'), parentId: dirParentIds.get(dirPath) || (typeof folderStack !== 'undefined' && folderStack[0] && folderStack[0].id) || 'root',
                    name: data.name, type: 'file', content: data.content,
                    encoding: data.encoding || 'text', timestamp: Date.now()
                });
            }
        });

        // Prune bottom-up: a child folder that empties out can make its own
        // parent empty too, so this repeats until a full pass removes nothing
        // more. A file id "survives" if it's a locked file (gitApplyTree never
        // touches those, so they always count as content) or an unlocked file
        // whose path is still present in targetTree; every other tracked file
        // is one of the deletes just issued above.
        if (foldersToCheck.size) {
            const survivingFileIds = new Set();
            allFiles.forEach(f => {
                if (f.type !== 'file') return;
                if (f.isLocked || targetTree.has(pathMap.get(f.id))) survivingFileIds.add(f.id);
            });
            const createdFolderIds = new Set(dirParentIds.values());
            const removedFolderIds = new Set();
            let changed = true;
            while (changed) {
                changed = false;
                foldersToCheck.forEach(folderId => {
                    if (removedFolderIds.has(folderId) || folderId === rootId || createdFolderIds.has(folderId)) return;
                    const folder = allFiles.find(f => f.id === folderId && f.type === 'folder');
                    if (!folder) return;
                    const hasChildren = allFiles.some(f => f.parentId === folderId && (
                        (f.type === 'file' && survivingFileIds.has(f.id)) ||
                        (f.type === 'folder' && !removedFolderIds.has(f.id)) ||
                        // A nested workspace (or anything else that isn't a plain
                        // file/folder) always counts as content: it has its own
                        // separate database that Source Control doesn't track,
                        // so its parent folder must never be pruned out from
                        // under it.
                        (f.type !== 'file' && f.type !== 'folder')
                    ));
                    if (!hasChildren) {
                        store.delete(folderId);
                        removedFolderIds.add(folderId);
                        if (folder.parentId) foldersToCheck.add(folder.parentId);
                        changed = true;
                    }
                });
            }
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

// --- Content addressing -----------------------------------------------------
// A commit's id is the SHA-1 hex digest of its own canonical content, exactly
// like real git: same message + author + timestamp + parents + files always
// produces the same id, so two branches that haven't diverged share the
// literal same commit object in `objects` rather than each holding an
// independent copy of it (see gitCommitBranch et al below). SubtleCrypto is
// available in every browser this app already requires (Monaco, Pyodide) as
// long as the page is served over https or localhost, which this app's own
// deployment (Vercel) always is.
async function gitHashCommit(commitContent) {
    const canonical = JSON.stringify({
        message: commitContent.message, author: commitContent.author, authorEmail: commitContent.authorEmail || '',
        timestamp: commitContent.timestamp, parents: commitContent.parents,
        files: commitContent.files.map(f => ({ path: f.path, status: f.status, content: f.status === 'deleted' ? '' : f.content, encoding: f.encoding || 'text' }))
    });
    const bytes = new TextEncoder().encode(canonical);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// Short display form, same convention as `git log --oneline` / GitHub's UI.
function gitShortSha(sha) { return (sha || '').slice(0, 7); }

// One-time, per-repo conversion from the old { branches: { name: { commits:
// [...] } } } shape (a flat commits array duplicated onto every branch) into
// the new DAG shape. Every commit that ever existed is kept - nothing is
// dropped - and where two branches' old arrays share a common prefix (the
// overwhelmingly common case: a branch created and not yet diverged from its
// source), that shared prefix collapses onto the same chain of objects
// instead of becoming two independent copies, same as if it had always been
// built as a DAG. Ids are NOT rehashed here (that would require re-deriving
// every historical commit's exact original content shape, and would change
// ids the user may have already referenced/exported) - old Date.now()-based
// ids are kept as-is and simply reinterpreted as opaque object keys; only
// *new* commits made after this migration get real content-addressed ids.
function gitMigrateLegacyRepoShape(oldRepo) {
    const objects = {};
    const refs = {};
    const chainCache = new Map(); // old commit array reference -> its tip sha, so an identical array (by reference) computed twice isn't rebuilt twice
    Object.keys(oldRepo.branches || {}).forEach(branchName => {
        const branch = oldRepo.branches[branchName];
        const commits = (branch && branch.commits) || [];
        if (chainCache.has(commits)) { refs[branchName] = chainCache.get(commits); return; }
        let parentSha = null;
        commits.forEach(c => {
            // Reuse the id as-is if nothing with that id exists yet or already matches;
            // legacy ids were unique per commit (gitNewId), so collisions aren't expected,
            // but content is trusted over a coincidental key match just in case.
            objects[c.id] = {
                message: c.message, author: c.author || 'You', authorEmail: c.authorEmail || '',
                timestamp: c.timestamp, parents: parentSha ? [parentSha] : [], files: c.files
            };
            parentSha = c.id;
        });
        refs[branchName] = parentSha;
        chainCache.set(commits, parentSha);
    });
    return { objects, refs, stash: oldRepo.stash || [] };
}

// --- Commit-history helpers (DAG-aware) -------------------------------------
// Walks a commit's ancestor chain via first-parent-then-all-parents order
// (a simple, deterministic linearization - not full topological sort, since
// nothing here needs one) and returns every sha reachable from `sha`,
// starting with `sha` itself. Used as the basis for HEAD-tree reconstruction,
// merge-base computation, and ahead/behind counts.
function gitWalkAncestors(repo, sha) {
    const visited = new Set();
    const order = [];
    const stack = sha ? [sha] : [];
    while (stack.length) {
        const cur = stack.shift();
        if (!cur || visited.has(cur)) continue;
        visited.add(cur);
        order.push(cur);
        const commit = repo.objects[cur];
        if (commit) stack.push(...commit.parents);
    }
    return order;
}
// Reconstructs "the tree at HEAD" by replaying a commit's ancestor chain
// oldest-first (nothing redundant is stored, exactly like real git). branchOrSha
// may be a branch name (looked up via refs) or a raw commit sha directly - the
// latter is what merge-base and blame-style lookups need.
function gitComputeHeadTree(repo, branchOrSha) {
    const headSha = Object.prototype.hasOwnProperty.call(repo.refs || {}, branchOrSha) ? repo.refs[branchOrSha] : branchOrSha;
    const tree = new Map();
    if (!headSha) return tree;
    const chain = gitWalkAncestors(repo, headSha).reverse(); // oldest ancestor first
    chain.forEach(sha => {
        const commit = repo.objects[sha];
        if (!commit) return;
        commit.files.forEach(f => {
            if (f.status === 'deleted') tree.delete(f.path);
            else tree.set(f.path, { content: f.content, encoding: f.encoding || 'text', name: f.name });
        });
    });
    return tree;
}
// Tree as of a specific commit sha, regardless of which branch currently
// points at or past it - a plain alias now that trees are computed from a
// sha rather than "replay this branch's array until this id shows up",
// kept as its own name since callers read more clearly with it.
function gitComputeTreeAtCommit(repo, branchName, commitSha) {
    return gitComputeHeadTree(repo, commitSha);
}
// The nearest common ancestor of two commits - the DAG walk that a flat
// per-branch array can't answer at all. Used by merge to do a real 3-way
// merge (common ancestor + both tips) instead of "whichever branch is merged
// in just overwrites", and by the status bar / branch picker's ahead/behind
// counts.
function gitMergeBase(repo, shaA, shaB) {
    if (!shaA || !shaB) return null;
    const ancestorsA = new Set(gitWalkAncestors(repo, shaA));
    for (const sha of gitWalkAncestors(repo, shaB)) if (ancestorsA.has(sha)) return sha;
    return null;
}
// How many commits are reachable from `ahead` but not from `base` - real
// git's "N ahead" count.
function gitCountAhead(repo, ahead, base) {
    if (!ahead) return 0;
    const baseAncestors = new Set(base ? gitWalkAncestors(repo, base) : []);
    return gitWalkAncestors(repo, ahead).filter(sha => !baseAncestors.has(sha)).length;
}

// --- Log graph (branch lanes) ------------------------------------------------
// Topologically sorts the union of every branch tip's ancestry (newest-first,
// a commit always emitted before any of its own parents) so the History tab
// can show one merged timeline across every branch at once, not just the
// current branch's own linear history.
function gitTopoOrder(repo, tips) {
    const allShas = new Set();
    tips.forEach(tip => {
        if (!tip) return;
        const stack = [tip];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur || allShas.has(cur)) continue;
            allShas.add(cur);
            const c = repo.objects[cur];
            if (c) c.parents.forEach(p => stack.push(p));
        }
    });
    const remainingChildren = new Map();
    allShas.forEach(sha => remainingChildren.set(sha, 0));
    allShas.forEach(sha => {
        const c = repo.objects[sha];
        if (c) c.parents.forEach(p => { if (allShas.has(p)) remainingChildren.set(p, (remainingChildren.get(p) || 0) + 1); });
    });
    const queue = [...allShas].filter(sha => remainingChildren.get(sha) === 0);
    const byTime = (a, b) => (repo.objects[b] ? repo.objects[b].timestamp : 0) - (repo.objects[a] ? repo.objects[a].timestamp : 0);
    const order = [];
    while (queue.length) {
        queue.sort(byTime);
        const sha = queue.shift();
        order.push(sha);
        const c = repo.objects[sha];
        if (c) c.parents.forEach(p => {
            if (!allShas.has(p)) return;
            remainingChildren.set(p, remainingChildren.get(p) - 1);
            if (remainingChildren.get(p) === 0) queue.push(p);
        });
    }
    return order;
}
// Assigns each commit a vertical "lane" (column) so a graph can be drawn: a
// lane is opened when a branch tip or a merge's second parent first appears,
// continues straight down through ordinary commits, and closes (joins) when
// another lane's line reaches the same commit from a different direction.
// Mirrors how `git log --graph` lays out branch lines, using the DAG's real
// parent pointers rather than approximating from a flat list.
function gitBuildGraphRows(repo, tips) {
    const order = gitTopoOrder(repo, tips);
    const rows = [];
    let lanes = [];
    order.forEach(sha => {
        const commit = repo.objects[sha];
        if (!commit) return;
        let laneIdx = lanes.findIndex(l => l === sha);
        if (laneIdx === -1) {
            laneIdx = lanes.findIndex(l => l === null);
            if (laneIdx === -1) { lanes.push(null); laneIdx = lanes.length - 1; }
        }
        const joiningLanes = [];
        lanes.forEach((l, i) => { if (l === sha && i !== laneIdx) joiningLanes.push(i); });

        const parents = commit.parents;
        lanes[laneIdx] = parents[0] || null;
        joiningLanes.forEach(i => { lanes[i] = null; });
        const extraParentLanes = [];
        parents.slice(1).forEach(p => {
            let idx = lanes.findIndex(l => l === null);
            if (idx === -1) { lanes.push(null); idx = lanes.length - 1; }
            lanes[idx] = p;
            extraParentLanes.push(idx);
        });

        rows.push({
            sha: sha, lane: laneIdx, joiningLanes: joiningLanes, extraParentLanes: extraParentLanes,
            activeLanesAfter: lanes.map((l, i) => l !== null ? i : null).filter(i => i !== null)
        });
    });
    return rows;
}
const GIT_LANE_COLORS = ['#3794ff', '#4caf50', '#e8833a', '#c678dd', '#e05561', '#3aafa9'];
function gitLaneColor(i) { return GIT_LANE_COLORS[i % GIT_LANE_COLORS.length]; }
// Renders one row's slice of the graph as a small inline SVG: passthrough
// lines for lanes not involved in this commit, this commit's own dot, and
// diagonals for any merge (extra parents opening new lanes) or join
// (another lane's line converging into this commit). activeLanesBefore is
// simply the previous row's activeLanesAfter.
function gitRenderGraphCell(row, activeLanesBefore, laneCount) {
    const LANE_W = 15, ROW_H = 34, DOT_R = 4;
    const w = Math.max(LANE_W * (laneCount + 1), LANE_W * 2);
    const midY = ROW_H / 2;
    const x = function(i) { return LANE_W * i + LANE_W / 2; };
    let svg = '';
    const involvedLanes = new Set([row.lane].concat(row.joiningLanes, row.extraParentLanes));
    activeLanesBefore.forEach(i => {
        if (row.activeLanesAfter.includes(i) && !involvedLanes.has(i)) {
            svg += '<line x1="' + x(i) + '" y1="0" x2="' + x(i) + '" y2="' + ROW_H + '" stroke="' + gitLaneColor(i) + '" stroke-width="2"/>';
        }
    });
    if (activeLanesBefore.includes(row.lane)) {
        svg += '<line x1="' + x(row.lane) + '" y1="0" x2="' + x(row.lane) + '" y2="' + midY + '" stroke="' + gitLaneColor(row.lane) + '" stroke-width="2"/>';
    }
    row.joiningLanes.forEach(j => {
        svg += '<path d="M ' + x(j) + ' 0 L ' + x(row.lane) + ' ' + midY + '" stroke="' + gitLaneColor(j) + '" stroke-width="2" fill="none"/>';
    });
    if (row.activeLanesAfter.includes(row.lane)) {
        svg += '<line x1="' + x(row.lane) + '" y1="' + midY + '" x2="' + x(row.lane) + '" y2="' + ROW_H + '" stroke="' + gitLaneColor(row.lane) + '" stroke-width="2"/>';
    }
    row.extraParentLanes.forEach(e => {
        svg += '<path d="M ' + x(row.lane) + ' ' + midY + ' L ' + x(e) + ' ' + ROW_H + '" stroke="' + gitLaneColor(e) + '" stroke-width="2" fill="none"/>';
    });
    svg += '<circle cx="' + x(row.lane) + '" cy="' + midY + '" r="' + DOT_R + '" fill="' + gitLaneColor(row.lane) + '" stroke="var(--bg-white)" stroke-width="1.5"/>';
    return '<svg width="' + w + '" height="' + ROW_H + '" viewBox="0 0 ' + w + ' ' + ROW_H + '" style="flex-shrink:0; overflow:visible; display:block;">' + svg + '</svg>';
}
// --- .gitignore ---------------------------------------------------------
// A deliberately focused subset of real .gitignore syntax - blank lines and
// #comments, a leading / to anchor a pattern to the repo root, a trailing /
// for directory-only patterns, * and ? wildcards, and leading ! to negate
// (un-ignore) an earlier match, with later rules winning over earlier ones -
// rather than the full spec (no per-directory nested .gitignore files yet,
// no ** double-star). This covers the overwhelming majority of real-world
// .gitignore files (node_modules/, *.log, /dist, build artifacts, OS/editor
// cruft) without the complexity of a complete implementation.
function gitGlobToRegexBody(pattern) {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return re;
}
function gitParseGitignore(content) {
    if (!content) return [];
    return content.split('\n').map(line => line.replace(/\r$/, '')).map(raw => {
        let line = raw.trim();
        if (!line || line.startsWith('#')) return null;
        let negate = false;
        if (line.startsWith('!')) { negate = true; line = line.slice(1); }
        let dirOnly = false;
        if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
        let anchored = false;
        if (line.startsWith('/')) { anchored = true; line = line.slice(1); }
        if (line.includes('/')) anchored = true; // a slash anywhere else also anchors, matching real git
        if (!line) return null;
        const body = gitGlobToRegexBody(line);
        const regexStr = anchored ? '^' + body + '$' : '(^|.*/)' + body + '$';
        let regex;
        try { regex = new RegExp(regexStr); } catch (e) { return null; }
        return { raw, negate, dirOnly, regex };
    }).filter(Boolean);
}
// path is this app's own absolute-style path ("/src/app.js"). Checks the
// full path AND every ancestor directory against every rule, since a
// dirOnly rule like "node_modules/" must ignore everything nested inside
// it, not just a literal path segment named exactly that.
function gitIsIgnored(path, rules) {
    if (!rules || !rules.length) return false;
    if (path === '/.gitignore') return false; // .gitignore itself is always trackable, never ignorable
    const rel = path.replace(/^\//, '');
    const segments = rel.split('/');
    const candidates = [];
    for (let i = 1; i <= segments.length; i++) candidates.push(segments.slice(0, i).join('/'));
    let ignored = false;
    rules.forEach(rule => {
        for (const cand of candidates) {
            if (rule.dirOnly && cand === rel) continue;
            if (rule.regex.test(cand)) { ignored = !rule.negate; break; }
        }
    });
    return ignored;
}
// Reads .gitignore straight out of a tree (working tree or a historical
// commit's tree - same Map shape either way), parsed fresh each time rather
// than cached, since the file can change between one render and the next
// and a stale rule set would silently under- or over-ignore paths.
function gitGetIgnoreRules(tree) {
    const f = tree.get('/.gitignore');
    return f ? gitParseGitignore(f.content) : [];
}
// Applied to the output of gitComputeChanges, never to a working tree map
// directly: an already-tracked file must keep showing its modifications and
// deletions even if a LATER .gitignore addition would now match its name or
// location - exactly like real git, which only stops NEW/untracked files
// from being picked up and never silently treats a newly-ignored existing
// file as deleted. Only 'added' (i.e. previously untracked) entries are
// ever suppressed here.
function gitFilterIgnoredAdds(changes, rules) {
    if (!rules || !rules.length) return changes;
    return changes.filter(c => !(c.status === 'added' && gitIsIgnored(c.path, rules)));
}

// Generic "diff two path->{content,name,encoding} maps" - used both for
// working-tree-vs-HEAD (the Changes tab) and merged-tree-vs-target-HEAD
// (building a merge commit), since both are the same shape of comparison.
function gitComputeChanges(newTree, oldTree) {
    const changes = [];
    newTree.forEach((nf, path) => {
        const of = oldTree.get(path);
        if (!of) changes.push({ path, name: nf.name, status: 'added', content: nf.content, encoding: nf.encoding });
        else if (of.content !== nf.content) changes.push({ path, name: nf.name, status: 'modified', content: nf.content, encoding: nf.encoding });
    });
    oldTree.forEach((of, path) => {
        if (!newTree.has(path)) changes.push({ path, name: of.name, status: 'deleted', content: '', encoding: of.encoding });
    });
    changes.sort((a, b) => a.path.localeCompare(b.path));
    return changes;
}
// Creates a new commit object, hashes it, stores it in the shared object
// store, and returns its sha. Does NOT move any ref - callers point the
// relevant branch at the returned sha themselves, which is what makes
// gitCommitBranch reusable for normal commits, merge commits (two parents)
// and pull-recorded commits alike.
async function gitCreateCommitObject(repo, message, parents, files, authorFields) {
    const content = { message, author: authorFields.author, authorEmail: authorFields.authorEmail, timestamp: Date.now(), parents: parents.filter(Boolean), files };
    const sha = await gitHashCommit(content);
    // Content-identical commit already exists (e.g. an empty merge commit
    // replayed, or the exact same fix committed on two branches independently)
    // - point at the existing object instead of storing a duplicate.
    if (!repo.objects[sha]) repo.objects[sha] = content;
    return sha;
}

// --- Merge conflict detection (real 3-way merge) ----------------------------
// Compares target and source against their nearest common ancestor (base) -
// the same three-way comparison real git does - instead of the old
// "source always overwrites target" behavior. For every path touched on
// either side:
//   - only target touched it (or it's identical on both sides) -> take target
//   - only source touched it -> take source
//   - both touched it and agree on the result -> no conflict, take that result
//   - both touched it and disagree -> CONFLICT
// A path with no base entry (added fresh on one or both sides since they
// diverged) is handled the same way, using "absent" as its base state.
// Returns { merged, conflicts } where `merged` is a path->file Map with
// conflicted text files holding real <<<<<<< / ======= / >>>>>>> markers
// (git's own convention) already inlined into their content, ready to drop
// into the working tree for the user to resolve by hand; `conflicts` is the
// list of paths that need resolution before this merge can be committed.
function gitThreeWayMerge(baseTree, targetTree, sourceTree, targetLabel, sourceLabel) {
    const paths = new Set([...baseTree.keys(), ...targetTree.keys(), ...sourceTree.keys()]);
    const merged = new Map();
    const conflicts = [];
    paths.forEach(path => {
        const b = baseTree.get(path) || null;
        const t = targetTree.get(path) || null;
        const s = sourceTree.get(path) || null;
        const same = (x, y) => (x === y) || (x && y && x.content === y.content && (x.encoding || 'text') === (y.encoding || 'text'));

        if (same(t, s)) { if (t) merged.set(path, t); return; } // identical on both sides (including both-deleted) - trivially fine
        if (same(t, b)) { if (s) merged.set(path, s); return; } // target didn't touch it -> take source's side (add, modify or delete)
        if (same(s, b)) { if (t) merged.set(path, t); return; } // source didn't touch it -> take target's side

        // Both sides touched this path relative to base, and disagree. Binary
        // files can't be line-merged or marked - treat any such disagreement
        // as a conflict resolved only by picking one side outright.
        const isBinary = (t && t.encoding === 'base64') || (s && s.encoding === 'base64');
        if (isBinary) {
            conflicts.push({ path, name: (t || s).name, kind: 'binary', target: t, source: s });
            merged.set(path, t || s); // placeholder so the working tree has *something* until resolved
            return;
        }
        if (!t && s) { // target deleted it, source modified it
            conflicts.push({ path, name: s.name, kind: 'delete-modify', target: null, source: s });
            merged.set(path, s);
            return;
        }
        if (t && !s) { // source deleted it, target modified it
            conflicts.push({ path, name: t.name, kind: 'modify-delete', target: t, source: null });
            merged.set(path, t);
            return;
        }
        // Both modified it (or both added it fresh) to different content -
        // the classic case: inline real conflict markers into the text.
        const markered = `<<<<<<< ${targetLabel}\n${t.content}\n=======\n${s.content}\n>>>>>>> ${sourceLabel}\n`;
        conflicts.push({ path, name: t.name, kind: 'content', target: t, source: s });
        merged.set(path, { content: markered, encoding: 'text', name: t.name });
    });
    return { merged, conflicts };
}
// Pending-merge state, mirroring what real git tracks in MERGE_HEAD while a
// conflicted merge is unresolved: which branches/commits are being merged,
// and which paths still need resolving. Survives a page reload the same way
// everything else in Source Control does, since it's just localStorage - the
// user can close the tab mid-conflict-resolution and pick it back up later
// instead of losing merge context.
function gitGetPendingMerge(dbName) {
    try {
        const raw = localStorage.getItem(gitStorageKey(dbName, 'mergestate'));
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
}
function gitSavePendingMerge(dbName, state) {
    if (state) localStorage.setItem(gitStorageKey(dbName, 'mergestate'), JSON.stringify(state));
    else {
        localStorage.removeItem(gitStorageKey(dbName, 'mergestate'));
        if (!gitGetPendingRebase(dbName)) gitClearNotice('git-conflict-' + dbName);
    }
}
// Pending-rebase state, mirroring real git's rebase-in-progress bookkeeping
// (normally spread across .git/rebase-merge/*): which branch is being
// replayed onto what, the full ordered list of original commit shas still
// to come, how far it's gotten (doneShas, in replay order - the NEW shas
// each original commit became once replayed), and which paths are
// unresolved for whichever commit it's currently stuck on. Survives a
// reload the same way pending-merge does.
function gitGetPendingRebase(dbName) {
    try {
        const raw = localStorage.getItem(gitStorageKey(dbName, 'rebasestate'));
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
}
function gitSavePendingRebase(dbName, state) {
    if (state) localStorage.setItem(gitStorageKey(dbName, 'rebasestate'), JSON.stringify(state));
    else {
        localStorage.removeItem(gitStorageKey(dbName, 'rebasestate'));
        if (!gitGetPendingMerge(dbName)) gitClearNotice('git-conflict-' + dbName);
    }
}


// --- Diff engine (loaded on demand, same two-CDN-source pattern used
// throughout this app for pdf.js/php-wasm/marked) -------------------------
async function gitGetDiffLib() {
    if (window._gitDiffLib) return window._gitDiffLib;
    if (window._gitDiffLibLoading) {
        while (!window._gitDiffLib && window._gitDiffLibLoading) await new Promise(r => setTimeout(r, 50));
        return window._gitDiffLib;
    }
    window._gitDiffLibLoading = true;
    let mod;
    try { mod = await import('https://esm.sh/diff@9.0.0'); }
    catch (e1) {
        try { mod = await import('https://cdn.jsdelivr.net/npm/diff@9.0.0/+esm'); }
        catch (e2) { console.error('Diff library failed to load from all sources.', e1, e2); window._gitDiffLibLoading = false; return null; }
    }
    window._gitDiffLib = mod;
    window._gitDiffLibLoading = false;
    return mod;
}
// Groups a flat diffLines() result into git's own hunk model: contiguous
// runs of change surrounded by up to `contextLines` of unchanged context,
// with the (often much larger) stretches of unchanged lines BETWEEN hunks
// collapsed into a single expandable marker rather than shown in full. This
// is what makes a large file's diff readable at all instead of scrolling
// past hundreds of untouched lines to find the three that actually changed.
function gitBuildHunks(parts, contextLines) {
    contextLines = contextLines == null ? 3 : contextLines;
    const rows = [];
    let oldNum = 1, newNum = 1;
    parts.forEach(part => {
        const lines = part.value.replace(/\n$/, '').split('\n');
        lines.forEach(text => {
            if (part.added) rows.push({ type: 'add', text, newNum: newNum++ });
            else if (part.removed) rows.push({ type: 'remove', text, oldNum: oldNum++ });
            else rows.push({ type: 'context', text, oldNum: oldNum++, newNum: newNum++ });
        });
    });
    const changedIdx = rows.map((r, i) => r.type !== 'context' ? i : -1).filter(i => i !== -1);
    if (changedIdx.length === 0) return { hunks: [], gaps: [{ before: 0, count: rows.length, fromRow: 0, toRow: rows.length - 1 }], rows, allContext: true };

    const ranges = [];
    let curStart = Math.max(0, changedIdx[0] - contextLines);
    let curEnd = Math.min(rows.length - 1, changedIdx[0] + contextLines);
    for (let k = 1; k < changedIdx.length; k++) {
        const idx = changedIdx[k];
        const windowStart = Math.max(0, idx - contextLines);
        if (windowStart <= curEnd + 1) curEnd = Math.min(rows.length - 1, idx + contextLines);
        else { ranges.push([curStart, curEnd]); curStart = windowStart; curEnd = Math.min(rows.length - 1, idx + contextLines); }
    }
    ranges.push([curStart, curEnd]);

    const hunks = ranges.map(([start, end]) => {
        const hunkRows = rows.slice(start, end + 1);
        const oldNums = hunkRows.filter(r => r.oldNum !== undefined).map(r => r.oldNum);
        const newNums = hunkRows.filter(r => r.newNum !== undefined).map(r => r.newNum);
        return { oldStart: oldNums[0] || 0, oldLines: oldNums.length, newStart: newNums[0] || 0, newLines: newNums.length, rows: hunkRows };
    });

    const gaps = [];
    let prevEnd = -1;
    ranges.forEach(([start], i) => { gaps.push({ before: i, count: start - prevEnd - 1, fromRow: prevEnd + 1, toRow: start - 1 }); prevEnd = ranges[i][1]; });
    gaps.push({ before: ranges.length, count: rows.length - prevEnd - 1, fromRow: prevEnd + 1, toRow: rows.length - 1 });

    return { hunks, gaps, rows };
}
function gitDiffGapHtml(gap) {
    if (gap.count <= 0) return '';
    return `<div class="git-diff-gap" data-git-diff-action="expand-gap" data-from="${gap.fromRow}" data-to="${gap.toRow}"><i class="ri-more-line"></i> ${gap.count} unchanged line${gap.count === 1 ? '' : 's'}</div>`;
}
function gitRenderUnifiedHtml(parts, contextLines) {
    const { hunks, gaps, allContext } = gitBuildHunks(parts, contextLines);
    if (allContext) return '<div class="git-diff-binary">No differences</div>';
    let html = '';
    hunks.forEach((hunk, i) => {
        html += gitDiffGapHtml(gaps[i]);
        html += `<div class="git-diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</div>`;
        hunk.rows.forEach(r => {
            const cls = r.type === 'add' ? 'git-diff-added' : r.type === 'remove' ? 'git-diff-removed' : 'git-diff-context';
            const marker = r.type === 'add' ? '+' : r.type === 'remove' ? '-' : ' ';
            html += `<div class="git-diff-row ${cls}"><span class="git-diff-ln git-diff-ln-old">${r.oldNum || ''}</span><span class="git-diff-ln git-diff-ln-new">${r.newNum || ''}</span><span class="git-diff-marker">${marker}</span><span class="git-diff-text">${gitEsc(r.text)}</span></div>`;
        });
    });
    html += gitDiffGapHtml(gaps[gaps.length - 1]);
    return html;
}
// Pairs up a hunk's remove/add runs 1:1 for side-by-side display (a
// straight replacement reads as aligned left/right rows, not a stack of
// every removal followed by every addition), padding the shorter side with
// blank cells when the counts don't match - the same convention every
// side-by-side diff tool uses.
function gitPairRemoveAdd(hunkRows) {
    const paired = [];
    let i = 0;
    while (i < hunkRows.length) {
        const r = hunkRows[i];
        if (r.type === 'context') { paired.push({ left: r, right: r }); i++; continue; }
        const removes = [];
        while (i < hunkRows.length && hunkRows[i].type === 'remove') { removes.push(hunkRows[i]); i++; }
        const adds = [];
        while (i < hunkRows.length && hunkRows[i].type === 'add') { adds.push(hunkRows[i]); i++; }
        const max = Math.max(removes.length, adds.length);
        for (let k = 0; k < max; k++) paired.push({ left: removes[k] || null, right: adds[k] || null });
    }
    return paired;
}
function gitRenderSideBySideHtml(parts, contextLines) {
    const { hunks, gaps, allContext } = gitBuildHunks(parts, contextLines);
    if (allContext) return '<div class="git-diff-binary">No differences</div>';
    let html = '';
    hunks.forEach((hunk, i) => {
        html += gitDiffGapHtml(gaps[i]);
        html += `<div class="git-diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</div>`;
        gitPairRemoveAdd(hunk.rows).forEach(pair => {
            const leftCls = !pair.left ? 'git-diff-blank' : pair.left.type === 'remove' ? 'git-diff-removed' : 'git-diff-context';
            const rightCls = !pair.right ? 'git-diff-blank' : pair.right.type === 'add' ? 'git-diff-added' : 'git-diff-context';
            html += `<div class="git-diff-sbs-row">`
                + `<span class="git-diff-sbs-side ${leftCls}"><span class="git-diff-ln">${pair.left ? (pair.left.oldNum || '') : ''}</span><span class="git-diff-text">${pair.left ? gitEsc(pair.left.text) : ''}</span></span>`
                + `<span class="git-diff-sbs-side ${rightCls}"><span class="git-diff-ln">${pair.right ? (pair.right.newNum || '') : ''}</span><span class="git-diff-text">${pair.right ? gitEsc(pair.right.text) : ''}</span></span>`
                + `</div>`;
        });
    });
    html += gitDiffGapHtml(gaps[gaps.length - 1]);
    return html;
}
async function gitRenderDiffHtml(oldContent, newContent, encoding, viewMode) {
    if (encoding === 'base64') {
        return `<div class="git-diff-binary"><i class="ri-file-forbid-line"></i><br>Binary file - diff not available</div>`;
    }
    if ((oldContent || '') === (newContent || '')) {
        return `<div class="git-diff-binary">No differences</div>`;
    }
    const diffLib = await gitGetDiffLib();
    if (!diffLib) {
        return `<div class="git-diff-binary"><i class="ri-error-warning-line"></i><br>Diff engine failed to load - check your connection</div>`;
    }
    const parts = diffLib.diffLines(oldContent || '', newContent || '');
    window._gitDiffParts = parts; // stashed for the expand-gap click handler, keyed by the currently open modal only
    return viewMode === 'split' ? gitRenderSideBySideHtml(parts, 3) : gitRenderUnifiedHtml(parts, 3);
}
window.gitShowDiff = async function(title, oldContent, newContent, encoding) {
    let overlay = document.getElementById('gitDiffOverlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'gitDiffOverlay';
    overlay.className = 'git-diff-overlay';
    const viewMode = window._gitDiffViewMode || 'unified';
    const canSplit = encoding !== 'base64' && (oldContent || '') !== (newContent || '');
    overlay.innerHTML = `
        <div class="git-diff-box ${viewMode === 'split' ? 'git-diff-box-wide' : ''}">
            <div class="git-diff-header">
                <span>${gitEsc(title)}</span>
                <div class="git-diff-header-actions">
                    ${canSplit ? `
                    <div class="git-diff-view-toggle">
                        <span class="${viewMode === 'unified' ? 'active' : ''}" data-git-diff-action="view-unified">Unified</span>
                        <span class="${viewMode === 'split' ? 'active' : ''}" data-git-diff-action="view-split">Split</span>
                    </div>` : ''}
                    <i class="ri-close-line git-action-icon" id="gitDiffClose"></i>
                </div>
            </div>
            <div class="git-diff-body" id="gitDiffBody"><div class="git-diff-binary">Loading diff...</div></div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); return; }
        const viewBtn = e.target.closest('[data-git-diff-action]');
        if (viewBtn) {
            const action = viewBtn.dataset.gitDiffAction;
            if (action === 'view-unified' || action === 'view-split') {
                window._gitDiffViewMode = action === 'view-split' ? 'split' : 'unified';
                window.gitShowDiff(title, oldContent, newContent, encoding);
                return;
            }
            if (action === 'expand-gap') {
                const from = parseInt(viewBtn.dataset.from, 10), to = parseInt(viewBtn.dataset.to, 10);
                const parts = window._gitDiffParts;
                if (!parts) return;
                const { rows } = gitBuildHunks(parts, 3);
                const revealed = rows.slice(from, to + 1).map(r =>
                    `<div class="git-diff-row git-diff-context"><span class="git-diff-ln git-diff-ln-old">${r.oldNum || ''}</span><span class="git-diff-ln git-diff-ln-new">${r.newNum || ''}</span><span class="git-diff-marker"> </span><span class="git-diff-text">${gitEsc(r.text)}</span></div>`
                ).join('');
                viewBtn.outerHTML = revealed;
            }
        }
    });
    overlay.querySelector('#gitDiffClose').onclick = () => overlay.remove();
    const html = await gitRenderDiffHtml(oldContent, newContent, encoding, viewMode);
    const bodyEl = document.getElementById('gitDiffBody');
    if (bodyEl) bodyEl.innerHTML = html;
};
async function gitOpenChangeDiff(path) {
    const database = db; const dbName = database.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const headTree = gitComputeHeadTree(repo, config.currentBranch);
    const workingTree = await gitGetWorkingTree(database);
    const hf = headTree.get(path), wf = workingTree.get(path);
    const name = (wf && wf.name) || (hf && hf.name) || path.split('/').pop();
    window.gitShowDiff(name, hf ? hf.content : '', wf ? wf.content : '', (wf && wf.encoding) || (hf && hf.encoding));
}
// Shows "mine" (target branch's version) vs "theirs" (source branch's
// version) directly for a conflicted path - the comparison that actually
// matters while deciding how to resolve, rather than a diff against the
// working file's own marker-laden content.
async function gitOpenConflictDiff(path) {
    const dbName = db.name;
    const pendingMerge = gitGetPendingMerge(dbName);
    const pendingRebase = gitGetPendingRebase(dbName);
    let targetSha, sourceSha, targetLabel, sourceLabel;
    if (pendingMerge && pendingMerge.conflictPaths.includes(path)) {
        targetSha = pendingMerge.targetSha; sourceSha = pendingMerge.sourceSha;
        targetLabel = pendingMerge.targetBranch; sourceLabel = pendingMerge.sourceBranch;
    } else if (pendingRebase && pendingRebase.conflictPaths.includes(path)) {
        targetSha = pendingRebase.newTip; sourceSha = pendingRebase.originalShas[pendingRebase.nextIndex];
        targetLabel = pendingRebase.ontoBranch; sourceLabel = `commit ${gitShortSha(sourceSha)}`;
    } else return;
    const repo = getGitRepo(dbName);
    const targetTree = gitComputeHeadTree(repo, targetSha);
    const sourceTree = gitComputeHeadTree(repo, sourceSha);
    const mine = targetTree.get(path), theirs = sourceTree.get(path);
    const name = (mine && mine.name) || (theirs && theirs.name) || path.split('/').pop();
    window.gitShowDiff(`${name} (${targetLabel} vs ${sourceLabel})`, mine ? mine.content : '', theirs ? theirs.content : '', (mine && mine.encoding) || (theirs && theirs.encoding));
}
function gitOpenCommitFileDiff(commitSha, path) {
    const dbName = db.name;
    const repo = getGitRepo(dbName);
    const commit = repo.objects[commitSha];
    if (!commit) return;
    const fileEntry = commit.files.find(f => f.path === path);
    if (!fileEntry) return;
    // A commit's "before" state is the tree at its first parent (root commits
    // have none, so beforeTree is empty) - real git's own definition of what
    // a commit's diff is against, and correct even when this commit sits on
    // a branch that has since diverged or been merged elsewhere.
    const beforeTree = gitComputeHeadTree(repo, commit.parents[0] || null);
    const before = beforeTree.get(path);
    window.gitShowDiff(fileEntry.name, before ? before.content : '', fileEntry.status === 'deleted' ? '' : fileEntry.content, fileEntry.encoding);
}

// --- Staging & committing --------------------------------------------------
function gitStagePath(path) {
    const dbName = db.name;
    const staged = getStagedPaths(dbName);
    if (!staged.includes(path)) staged.push(path);
    saveStagedPaths(dbName, staged);
    window.renderGitPanel();
}
function gitUnstagePath(path) {
    saveStagedPaths(db.name, getStagedPaths(db.name).filter(p => p !== path));
    window.renderGitPanel();
}
// Creates a starter .gitignore at the workspace root with common,
// generally-safe defaults for this app's own environment - build artifacts
// this app itself might generate (see archive.js, notebook-kernels.js),
// typical OS/editor cruft, and the same "binary-ish, usually-noise" spirit
// as this codebase's own BINARY_FILE_EXTS list, without trying to guess an
// individual project's actual dependency/build layout. Refuses if one
// already exists rather than overwriting a user's own rules.
async function gitCreateDefaultGitignore() {
    const database = db; const dbName = database.name;
    const workingTree = await gitGetWorkingTree(database);
    if (workingTree.has('/.gitignore')) { gitToast('.gitignore already exists'); return; }
    const starter = [
        '# Dependencies and build output',
        'node_modules/', 'dist/', 'build/', '.cache/',
        '',
        '# Logs',
        '*.log',
        '',
        '# OS and editor files',
        '.DS_Store', 'Thumbs.db', '*.swp',
        ''
    ].join('\n');
    const allFiles = await gitGetAllFiles(database);
    const rootId = (typeof folderStack !== 'undefined' && folderStack[0] && folderStack[0].id) || 'root';
    await gitPutFile(database, {
        id: gitNewId('gf'), parentId: rootId, name: '.gitignore', type: 'file',
        content: starter, encoding: 'text', timestamp: Date.now()
    });
    if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
    gitLog('gitignore', 'Created a starter .gitignore', 'info', null, dbName);
    window.renderGitPanel();
    if (window.showSuccessToast) window.showSuccessToast('.gitignore created');
}
async function gitStageAllChanges() {
    const database = db; const dbName = database.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const headTree = gitComputeHeadTree(repo, config.currentBranch);
    const workingTree = await gitGetWorkingTree(database);
    const changes = gitFilterIgnoredAdds(gitComputeChanges(workingTree, headTree), gitGetIgnoreRules(workingTree));
    saveStagedPaths(dbName, changes.map(c => c.path));
    window.renderGitPanel();
}
function gitUnstageAllChanges() {
    saveStagedPaths(db.name, []);
    window.renderGitPanel();
}
async function gitDiscardFile(path) {
    const database = db; const dbName = database.name;
    // A conflicted path must be resolved via gitResolveConflict (keeps
    // pending.unresolvedBinary in sync for binary conflicts) rather than
    // discarded directly - not reachable through the current UI (conflicted
    // paths render only in the Conflicts section, whose rows don't offer
    // this action), but guarded here in case that ever changes.
    const pending = gitGetPendingMerge(dbName);
    if (pending && pending.conflictPaths.includes(path)) { gitResolveConflict(path, 'mine'); return; }
    const doDiscard = async () => {
        const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
        const headTree = gitComputeHeadTree(repo, config.currentBranch);
        const workingTree = await gitGetWorkingTree(database);
        const target = new Map();
        workingTree.forEach((data, p) => { if (p !== path) target.set(p, data); });
        if (headTree.has(path)) target.set(path, headTree.get(path));
        await gitApplyTree(database, target);
        saveStagedPaths(dbName, getStagedPaths(dbName).filter(p => p !== path));
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        window.renderGitPanel();
    };
    if (window.showCustomModal) {
        window.showCustomModal({ title: 'Discard Changes', text: `Revert "${path.split('/').pop()}" back to its last committed state? This cannot be undone.`, submitText: 'Discard' }, doDiscard);
    } else if (confirm('Discard changes to this file?')) doDiscard();
}
async function gitDiscardAllChanges() {
    const database = db; const dbName = database.name;
    const doDiscard = async () => {
        const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
        await gitApplyTree(database, gitComputeHeadTree(repo, config.currentBranch));
        saveStagedPaths(dbName, []);
        // Discarding everything reverts the working tree to the current
        // branch's HEAD - which is exactly what it looked like before a
        // pending merge OR a pending rebase started (neither operation moves
        // the branch ref until it fully completes) - so either kind of
        // pending state is implicitly aborted here too, and must be cleared
        // with it. Leaving it in place would have Source Control still
        // reporting an operation in progress with no conflict markers left
        // anywhere to resolve.
        const wasPendingMerge = gitGetPendingMerge(dbName);
        const wasPendingRebase = gitGetPendingRebase(dbName);
        if (wasPendingMerge) gitSavePendingMerge(dbName, null);
        if (wasPendingRebase) gitSavePendingRebase(dbName, null);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        const abortedNote = wasPendingRebase ? ' (also aborted the in-progress rebase)' : wasPendingMerge ? ' (also aborted the in-progress merge)' : '';
        gitLog('discard-all', `Discarded all uncommitted changes on "${config.currentBranch}"${abortedNote}`, 'info', null, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast('All changes discarded');
    };
    const pending = gitGetPendingMerge(dbName);
    const pendingRebase = gitGetPendingRebase(dbName);
    const text = pendingRebase
        ? `This reverts every changed file back to its last committed state and aborts the in-progress rebase onto "${gitEsc(pendingRebase.ontoBranch)}". This cannot be undone.`
        : pending
        ? `This reverts every changed file back to its last committed state and aborts the in-progress merge of "${gitEsc(pending.sourceBranch)}". This cannot be undone.`
        : 'This reverts every changed file back to its last committed state. This cannot be undone.';
    if (window.showCustomModal) {
        window.showCustomModal({ title: 'Discard All Changes', text, submitText: 'Discard All' }, doDiscard);
    } else if (confirm('Discard all changes?')) doDiscard();
}
function gitInsertPrefix(prefix) {
    const ta = document.getElementById('gitCommitMsg');
    if (!ta) return;
    ta.value = prefix + ' ' + ta.value.replace(/^(feat|fix|docs|style|refactor|test|chore):\s*/, '');
    ta.focus();
}
// A path still has an unresolved conflict if it's a text file whose current
// working-tree content still contains git's own conflict markers - checked
// live against the file rather than a separate flag, since hand-editing out
// the markers is a valid way to resolve a text conflict. A binary conflict
// has no markers to check, so it stays listed in pending.unresolvedBinary
// until gitResolveConflict explicitly removes it (see below).
function gitFindUnresolvedConflicts(pending, workingTree) {
    if (!pending) return [];
    const unresolvedBinary = new Set(pending.unresolvedBinary || []);
    return pending.conflictPaths.filter(path => {
        if (unresolvedBinary.has(path)) return true;
        const f = workingTree.get(path);
        if (!f) return false; // resolved by deleting the file entirely (e.g. "keep neither")
        if (f.encoding === 'base64') return false; // binary and not in unresolvedBinary -> already resolved
        return typeof f.content === 'string' && f.content.includes('<<<<<<< ');
    });
}
async function gitDoCommit() {
    const ta = document.getElementById('gitCommitMsg');
    const database = db; const dbName = database.name;
    const pendingRebase = gitGetPendingRebase(dbName);
    if (pendingRebase && pendingRebase.conflictPaths.length > 0) {
        // The Commit button doubles as "Continue Rebase" while paused on a
        // conflict - each replayed commit keeps its OWN original message,
        // so whatever's typed in the box here is intentionally not used.
        await gitContinueRebase();
        return;
    }
    const pending = gitGetPendingMerge(dbName);
    const amendBox = document.getElementById('gitAmendMode');
    if (!pending && amendBox && amendBox.checked) {
        await gitAmendCommit(ta ? ta.value.trim() : '');
        return;
    }
    const message = ta ? ta.value.trim() : '';
    if (!message) { if (ta) ta.focus(); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);

    if (pending) {
        const workingTree = await gitGetWorkingTree(database);
        const unresolved = gitFindUnresolvedConflicts(pending, workingTree);
        if (unresolved.length > 0) {
            gitToast(`${unresolved.length} unresolved conflict(s) - resolve them before committing`);
            return;
        }
        // Every conflicted path has had its markers removed (or the file
        // deleted outright) - build the resulting commit from whatever the
        // working tree looks like now. A real conflicted merge gets both
        // original tips as parents; a conflicted cherry-pick (recognizable
        // by targetSha === sourceSha, the marker gitCherryPickCommit sets
        // since it never has a second parent to offer) gets just the one
        // parent it actually has, exactly like a normal commit - cherry-pick
        // never creates a merge commit, in real git or here.
        const isCherryPick = pending.targetSha === pending.sourceSha;
        const parents = isCherryPick ? [pending.targetSha] : [pending.targetSha, pending.sourceSha];
        const finalMessage = message || pending.cherryPickMessage || 'Merge';
        const headTree = gitComputeHeadTree(repo, pending.targetSha);
        const changes = gitComputeChanges(workingTree, headTree);
        const files = changes.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
        const sha = await gitCreateCommitObject(repo, finalMessage, parents, files, gitAuthorFields(dbName));
        gitMoveRef(dbName, repo, pending.targetBranch, sha, isCherryPick ? `Cherry-pick onto "${pending.targetBranch}"` : `Merge "${pending.sourceBranch}" into "${pending.targetBranch}"`);
        saveGitRepo(dbName, repo);
        saveStagedPaths(dbName, []);
        gitSavePendingMerge(dbName, null);
        if (isCherryPick) gitLog('cherry-pick', `Completed cherry-pick onto "${pending.targetBranch}" (${changes.length} file(s))`, 'success', { target: pending.targetBranch, sha: gitShortSha(sha) }, dbName);
        else gitLog('merge', `Completed merge of "${pending.sourceBranch}" into "${pending.targetBranch}" (${changes.length} file(s))`, 'success', { source: pending.sourceBranch, target: pending.targetBranch, sha: gitShortSha(sha) }, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast(isCherryPick ? 'Cherry-pick committed' : 'Merge committed');
        return;
    }

    const staged = getStagedPaths(dbName);
    if (staged.length === 0) return;

    if (!Object.prototype.hasOwnProperty.call(repo.refs, config.currentBranch)) repo.refs[config.currentBranch] = null;
    const headTree = gitComputeHeadTree(repo, config.currentBranch);
    const workingTree = await gitGetWorkingTree(database);
    const changes = gitComputeChanges(workingTree, headTree).filter(c => staged.includes(c.path));
    if (changes.length === 0) { saveStagedPaths(dbName, []); window.renderGitPanel(); return; }

    const files = changes.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
    const parentSha = repo.refs[config.currentBranch];
    const sha = await gitCreateCommitObject(repo, message, [parentSha], files, gitAuthorFields(dbName));
    gitMoveRef(dbName, repo, config.currentBranch, sha, `Commit: ${message.split('\n')[0]}`);
    saveGitRepo(dbName, repo);
    saveStagedPaths(dbName, []);
    gitLog('commit', `Committed ${changes.length} file(s) to "${config.currentBranch}": ${message}`, 'success', { branch: config.currentBranch, files: changes.length, sha: gitShortSha(sha) }, dbName);
    window.renderGitPanel();
    if (window.showSuccessToast) window.showSuccessToast('Committed');
}

// Replaces the current branch's tip commit with a new one carrying the same
// parent (so it does NOT become a merge or gain extra ancestry) - the new
// commit's files are the tip's own files with any currently staged changes
// folded in on top (staged changes win on any overlapping path), exactly
// like real git's `commit --amend` semantics: stage a fix, amend, and the
// fix becomes part of the previous commit instead of a new one.
// Only ever touches the CURRENT branch's tip - real git's own restriction,
// since amending is specifically "replace HEAD", not an arbitrary commit.
// The original commit object is left in place in the object store (simply
// unreachable once the ref moves) rather than deleted, mirroring how real
// git's amend leaves the old commit sitting in the reflog/object database
// until garbage collected - consistent with this app's own "no GC yet"
// state (see the object-store notes elsewhere; a future GC pass, if added,
// would be the place that reclaims commits no branch or tag can reach).
async function gitAmendCommit(newMessage) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before amending'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before amending'); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const tipSha = repo.refs[config.currentBranch];
    if (!tipSha) { gitToast('Nothing to amend - this branch has no commits yet'); return; }
    const tipCommit = repo.objects[tipSha];
    const message = (newMessage || '').trim() || tipCommit.message;

    const staged = getStagedPaths(dbName);
    const parentTree = gitComputeHeadTree(repo, tipCommit.parents[0] || null);
    const workingTree = await gitGetWorkingTree(database);
    const stagedChanges = gitComputeChanges(workingTree, gitComputeHeadTree(repo, config.currentBranch)).filter(c => staged.includes(c.path));

    // Start from the tip commit's own files, then overlay any staged changes
    // on top (staged wins on overlap) - this is the "fold staged fixes into
    // the previous commit" behavior amend is for.
    const fileMap = new Map(tipCommit.files.map(f => [f.path, f]));
    stagedChanges.forEach(c => fileMap.set(c.path, { path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
    const files = [...fileMap.values()];

    const sha = await gitCreateCommitObject(repo, message, [tipCommit.parents[0] || null], files, gitAuthorFields(dbName));
    gitMoveRef(dbName, repo, config.currentBranch, sha, `Amend: replaced ${gitShortSha(tipSha)}`);
    saveGitRepo(dbName, repo);
    if (stagedChanges.length) saveStagedPaths(dbName, staged.filter(p => !stagedChanges.some(c => c.path === p)));
    gitLog('amend', `Amended commit on "${config.currentBranch}"${stagedChanges.length ? ` (folded in ${stagedChanges.length} staged change(s))` : ''}`, 'success', { branch: config.currentBranch, sha: gitShortSha(sha), previousSha: gitShortSha(tipSha) }, dbName);
    window.renderGitPanel();
    if (window.showSuccessToast) window.showSuccessToast('Commit amended');
}
// Creates a NEW commit on top of the current tip whose changes are the exact
// inverse of the target commit's own changes - real git's `revert`, which
// undoes a commit's effect without rewriting history (unlike amend/reset,
// nothing already-shared or already-pushed becomes invalid). An add becomes
// a delete, a delete becomes a re-add of what existed just before that
// commit, and a modify becomes "put back whatever the file looked like
// immediately before this commit".
//
// Simplification, flagged rather than hidden: if a path this revert would
// touch has ALREADY changed again since the target commit (someone edited
// it further, or reverted it already), this does a plain overwrite with the
// pre-target-commit content rather than attempting a 3-way merge of the
// revert itself - the same "no conflict markers for this specific operation
// yet" posture already taken for the equivalent edge cases elsewhere. The
// check below at least surfaces this rather than silently clobbering newer
// work with no warning.
async function gitRevertCommit(targetSha) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before reverting'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before reverting'); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const targetCommit = repo.objects[targetSha];
    if (!targetCommit) return;
    const tipSha = repo.refs[config.currentBranch];
    if (!gitWalkAncestors(repo, tipSha).includes(targetSha)) { gitToast("That commit isn't in this branch's history"); return; }

    const beforeTargetTree = gitComputeHeadTree(repo, targetCommit.parents[0] || null);
    const currentTree = gitComputeHeadTree(repo, tipSha);
    const workingTree = await gitGetWorkingTree(database);

    const alreadyChangedSincePaths = [];
    const revertedTree = new Map(currentTree);
    targetCommit.files.forEach(f => {
        const currentlyAt = currentTree.get(f.path);
        const atCommitTime = f.status === 'added' ? undefined : f; // the file's OWN post-commit state, for detecting drift
        if (f.status === 'added') {
            // Reverting an add removes it - unless something else has since
            // changed it, in which case flag it and leave it alone rather
            // than silently deleting someone's newer work.
            if (currentlyAt && currentlyAt.content !== f.content) alreadyChangedSincePaths.push(f.path);
            else revertedTree.delete(f.path);
        } else {
            const restored = beforeTargetTree.get(f.path); // undefined if it didn't exist before this commit either
            if (currentlyAt && f.status !== 'deleted' && currentlyAt.content !== f.content) alreadyChangedSincePaths.push(f.path);
            if (restored) revertedTree.set(f.path, restored);
            else revertedTree.delete(f.path);
        }
    });

    const doRevert = async () => {
        const changes = gitComputeChanges(revertedTree, currentTree);
        if (changes.length === 0) { gitToast('Nothing to revert - already matches'); return; }
        const files = changes.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
        const shortMsg = targetCommit.message.split('\n')[0];
        const sha = await gitCreateCommitObject(repo, `Revert "${shortMsg}"`, [tipSha], files, gitAuthorFields(dbName));
        gitMoveRef(dbName, repo, config.currentBranch, sha, `Revert: "${shortMsg}"`);
        saveGitRepo(dbName, repo);
        await gitApplyTree(database, revertedTree);
        saveStagedPaths(dbName, []);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        gitLog('revert', `Reverted "${shortMsg}" on "${config.currentBranch}"`, 'success', { branch: config.currentBranch, sha: gitShortSha(sha), reverted: gitShortSha(targetSha) }, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast('Commit reverted');
    };

    const warnText = alreadyChangedSincePaths.length
        ? `${alreadyChangedSincePaths.length} file(s) touched by this commit have changed again since - reverting will overwrite that newer content with this commit's pre-change version. Continue?`
        : `This creates a new commit that undoes "${gitEsc(targetCommit.message)}". Continue?`;
    if (window.showCustomModal) window.showCustomModal({ title: 'Revert Commit', text: warnText, submitText: 'Revert' }, doRevert);
    else if (confirm(warnText)) doRevert();
}
// Moves the CURRENT branch's ref to point at a different (necessarily
// earlier-or-equal, since a branch ref can only usefully move within its own
// Applies one commit's changes on top of the current branch's tip as a NEW
// commit - real git's `cherry-pick`. Uses the same real 3-way merge as
// gitMergeBranch/rebase (base = the commit's own original parent, "ours" =
// the current tip, "theirs" = the commit's own resulting tree), so a
// genuine conflict here gets real conflict markers and a pending state to
// resolve, exactly like a conflicted merge - rather than the simpler
// silent-drift-detection gitRevertCommit uses, since cherry-pick applying
// FORWARD is exactly the shape of a merge step, not an inverse-and-warn.
async function gitCherryPickCommit(sourceSha) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before cherry-picking'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before cherry-picking'); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const sourceCommit = repo.objects[sourceSha];
    if (!sourceCommit) return;
    const tipSha = repo.refs[config.currentBranch] || null;

    const baseTree = gitComputeHeadTree(repo, sourceCommit.parents[0] || null);
    const oursTree = gitComputeHeadTree(repo, tipSha);
    const theirsTree = gitComputeHeadTree(repo, sourceSha);
    const { merged, conflicts } = gitThreeWayMerge(baseTree, oursTree, theirsTree, config.currentBranch, gitShortSha(sourceSha));
    const changes = gitComputeChanges(merged, oursTree);
    if (changes.length === 0 && conflicts.length === 0) { gitToast('Nothing to cherry-pick - already matches'); return; }

    await gitApplyTree(database, merged);
    saveStagedPaths(dbName, []);
    if (typeof loadFilesFromDB === 'function') loadFilesFromDB();

    const shortMsg = sourceCommit.message.split('\n')[0];
    if (conflicts.length > 0) {
        // Same pending shape as a conflicted merge - the working tree already
        // has real markers in it (gitThreeWayMerge wrote them), so this
        // reuses the exact same Changes-tab conflict UI and gitDoCommit's
        // merge-completion path, just parented differently (single parent -
        // the current tip - not two, since cherry-pick never creates a merge
        // commit; it's a new, ordinary, single-parent commit that happens to
        // carry another commit's changes).
        gitSavePendingMerge(dbName, {
            targetBranch: config.currentBranch, sourceBranch: `cherry-pick of ${gitShortSha(sourceSha)}`,
            targetSha: tipSha, sourceSha: tipSha, // single-parent on completion - see gitDoCommit's cherry-pick-aware branch below
            baseSha: sourceCommit.parents[0] || null,
            conflictPaths: conflicts.map(c => c.path), unresolvedBinary: conflicts.filter(c => c.kind === 'binary').map(c => c.path),
            startedAt: Date.now(), cherryPickMessage: `${shortMsg} (cherry picked from ${gitShortSha(sourceSha)})`
        });
        gitLog('cherry-pick', `Cherry-pick of ${gitShortSha(sourceSha)} has ${conflicts.length} conflict(s) - resolve and commit to finish`, 'error', { sha: gitShortSha(sourceSha), conflicts: conflicts.length }, dbName);
        window.renderGitPanel();
        gitNotifyConflict(dbName, 'Merge conflicts need your attention',
            `Cherry-picking ${gitShortSha(sourceSha)} left ${conflicts.length} conflict(s). Open Source Control, resolve them in the Changes tab, then commit to finish.`,
            `${conflicts.length} conflict(s) - resolve in Changes tab`);
        return;
    }

    const files = changes.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
    const sha = await gitCreateCommitObject(repo, `${shortMsg} (cherry picked from ${gitShortSha(sourceSha)})`, [tipSha], files, gitAuthorFields(dbName));
    gitMoveRef(dbName, repo, config.currentBranch, sha, `Cherry-pick: ${gitShortSha(sourceSha)}`);
    saveGitRepo(dbName, repo);
    gitLog('cherry-pick', `Cherry-picked ${gitShortSha(sourceSha)} onto "${config.currentBranch}"`, 'success', { branch: config.currentBranch, sha: gitShortSha(sha), source: gitShortSha(sourceSha) }, dbName);
    window.renderGitPanel();
    if (window.showSuccessToast) window.showSuccessToast('Cherry-picked');
}
// history for this UI) commit - real git's `reset`, in its three modes:
//   soft:  only the ref moves. Working files and staged paths are untouched,
//          so whatever the old tip's changes were now show up as staged
//          changes relative to the new (earlier) tip - "uncommit but keep
//          everything, including the index".
//   mixed: the ref moves and staged paths are cleared, but working files are
//          untouched - same "uncommit but keep the files" as soft, minus
//          the staging.
//   hard:  the ref moves AND the working tree is forced to match the new
//          tip exactly, discarding any uncommitted changes.
// Distinct from gitRestoreToCommit (which never moves any ref, and exists
// specifically to let you peek at old files without rewriting anything) -
// this is the one that actually rewrites what "current" means.
async function gitResetToCommit(targetSha, mode) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before resetting'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before resetting'); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const tipSha = repo.refs[config.currentBranch];
    if (!gitWalkAncestors(repo, tipSha).includes(targetSha)) { gitToast("That commit isn't in this branch's history"); return; }
    if (targetSha === tipSha) { gitToast('Already at this commit'); return; }

    const modeText = mode === 'hard' ? 'discard all uncommitted changes AND move the branch pointer, permanently losing the commits after this point (their changes will no longer be reachable from any branch)'
        : mode === 'soft' ? 'move the branch pointer back, keeping your files and staged changes exactly as they are - the undone commits\' changes reappear as staged changes'
        : 'move the branch pointer back and keep your files, but unstage everything';
    const doReset = async () => {
        gitMoveRef(dbName, repo, config.currentBranch, targetSha, `Reset (${mode}) from ${gitShortSha(tipSha)}`);
        saveGitRepo(dbName, repo);
        if (mode === 'hard') {
            await gitApplyTree(database, gitComputeHeadTree(repo, targetSha));
            saveStagedPaths(dbName, []);
            if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        } else if (mode === 'mixed') {
            saveStagedPaths(dbName, []);
        }
        // soft: working tree and staged paths are left exactly as they were -
        // no gitApplyTree call, no saveStagedPaths call.
        gitLog('reset', `Reset "${config.currentBranch}" to ${gitShortSha(targetSha)} (${mode})`, 'info', { branch: config.currentBranch, mode, target: gitShortSha(targetSha), from: gitShortSha(tipSha) }, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast(`Reset (${mode}) to ${gitShortSha(targetSha)}`);
    };
    const text = `This will ${modeText}.${mode === 'hard' ? ' This cannot be undone.' : ''} Continue?`;
    if (window.showCustomModal) window.showCustomModal({ title: `Reset (${mode})`, text, submitText: 'Reset' }, doReset);
    else if (confirm(text)) doReset();
}

// --- Branches, merge, stash, restore ---------------------------------------

// Own-property check. `repo.refs[name]` is NOT safe for "does this branch
// exist": refs is a plain object, so names like "constructor", "toString"
// or "__proto__" resolve to inherited Object.prototype members and look like
// existing branches (those names were silently rejected as duplicates).
function gitBranchExists(repo, name) {
    return Object.prototype.hasOwnProperty.call(repo.refs, name);
}

// Returns an error message for an unusable branch name, or null if it's fine.
// Rules mirror the subset of git's own ref-name rules that matter here.
// "__proto__" is rejected explicitly: assigning it as a key changes the
// object's prototype instead of creating a property, so the branch would
// vanish the moment the repo is saved to localStorage.


// --- Tags -----------------------------------------------------------------
// A separate namespace from branches (repo.tags, not repo.refs) - real git
// keeps refs/heads/ and refs/tags/ apart specifically so a tag and a branch
// can share a name without colliding; conflating them into one object here
// would recreate that exact ambiguity. A tag entry is { sha, annotation }:
// annotation is null for a lightweight tag (just a name pointing at a
// commit) or { message, tagger, timestamp } for an annotated one (real
// git's own distinction - annotated tags carry their own message/author,
// used for actual releases; lightweight tags are just bookmarks). Either
// way the tag POINTS AT a commit; it never points at another tag or at a
// branch, matching real git.
//
// Tags are local-only for now: pushing them to GitHub would mean writing to
// refs/tags/* via the Git Data API, a distinct action from this app's
// existing per-file Contents-API push (`git push --tags` is genuinely its
// own command in real git too) - flagged as a deliberate scope boundary for
// this pass rather than silently half-implemented.
//
// Forward note for whenever garbage collection (Tier 5, #30 on the feature
// list) gets built: a tag is a reachability root exactly like a branch ref -
// gitWalkAncestors must be seeded from every tag's sha in addition to every
// branch's tip, or a GC pass would incorrectly reclaim a tagged commit that
// no branch happens to still reach (a perfectly normal, common situation -
// e.g. a release tag on a commit whose branch was since deleted).
function gitTagExists(repo, name) {
    return Object.prototype.hasOwnProperty.call(repo.tags, name);
}
// Every tag name currently pointing at this exact sha, for rendering tag
// pills on the right commit row - mirrors labelsBySha's branch-label lookup
// in renderHistoryTab.
function gitTagsAtSha(repo, sha) {
    return Object.keys(repo.tags).filter(name => repo.tags[name].sha === sha);
}
function gitCreateTag(dbName, name, sha, annotation) {
    const repo = getGitRepo(dbName);
    const err = gitValidateBranchName(name); // same ref-name rules real git applies to any ref
    if (err) return { error: err };
    if (!repo.objects[sha]) return { error: 'That commit no longer exists.' };
    if (gitTagExists(repo, name)) return { error: `Tag "${name}" already exists.` };
    repo.tags[name] = { sha, annotation: annotation || null };
    saveGitRepo(dbName, repo);
    gitLog('tag', `Created tag "${name}" at ${gitShortSha(sha)}${annotation ? ' (annotated)' : ''}`, 'success', { tag: name, sha: gitShortSha(sha) }, dbName);
    return { ok: true };
}
function gitDeleteTag(tagName) {
    const dbName = db.name;
    const repo = getGitRepo(dbName);
    if (!gitTagExists(repo, tagName)) return;
    const doDelete = () => {
        delete repo.tags[tagName];
        saveGitRepo(dbName, repo);
        gitLog('tag-delete', `Deleted tag "${tagName}"`, 'info', { tag: tagName }, dbName);
        window.renderGitPanel();
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'Delete Tag', text: `Delete tag "${gitEsc(tagName)}"? This only removes the tag - the commit it points to is unaffected.`, submitText: 'Delete' }, doDelete);
    else if (confirm(`Delete tag "${tagName}"?`)) doDelete();
}
function gitValidateBranchName(name) {
    if (!name) return 'Branch name cannot be empty.';
    if (name === '__proto__') return 'That name is reserved.';
    if (/\s/.test(name)) return 'Branch names cannot contain spaces. Try using "-" or "_" instead.';
    if (/[~^:?*\[\\]/.test(name) || /[\x00-\x1f\x7f]/.test(name)) return 'Branch names cannot contain ~ ^ : ? * [ \\ or control characters.';
    if (name.includes('..') || name.includes('@{') || name.includes('//')) return 'Branch names cannot contain "..", "@{" or "//".';
    if (name.startsWith('/') || name.endsWith('/') || name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('.lock')) {
        return 'Branch names cannot start with "/", "-" or ".", or end with "/", "." or ".lock".';
    }
    if (name === '@') return 'That name is reserved.';
    if (name.length > 100) return 'Branch names must be 100 characters or fewer.';
    return null;
}

// The shared modal (app.js) deliberately stays open after an input-modal's
// callback runs, so the callback can show a validation message and let the
// user fix their input; closing it is the caller's job. These two helpers are
// that contract. Every path through a branch dialog's callback must end in
// exactly one of them - previously none did, so the dialog never dismissed,
// and bad input (empty/duplicate name) silently did nothing at all.
function gitModalError(message) {
    const el = document.getElementById('genModalError');
    if (!el) { if (window.showSuccessToast) window.showSuccessToast(message); return; }
    el.textContent = message;
    el.style.display = 'block';
}
function gitModalClose() {
    if (typeof closeGenModal === 'function') closeGenModal();
}

function gitConfirmIfDirty(message, action) {
    const database = db; const dbName = database.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const headTree = gitComputeHeadTree(repo, config.currentBranch);
    gitGetWorkingTree(database).then(workingTree => {
        const changes = gitFilterIgnoredAdds(gitComputeChanges(workingTree, headTree), gitGetIgnoreRules(workingTree));
        const dirty = changes.length > 0;
        if (!dirty) { action(); return; }
        if (window.showCustomModal) {
            window.showCustomModal({ title: 'Uncommitted Changes', text: message, submitText: 'Discard & Continue' }, action);
        } else if (confirm(message)) action();
    });
}
function gitSwitchBranch(branchName) {
    const database = db; const dbName = database.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    if (branchName === config.currentBranch || !gitBranchExists(repo, branchName)) return;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before switching branches'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before switching branches'); return; }
    gitConfirmIfDirty(`Switching to "${branchName}" will discard your uncommitted changes. Continue?`, async () => {
        await gitApplyTree(database, gitComputeHeadTree(repo, branchName));
        const fromBranch = config.currentBranch;
        config.currentBranch = branchName;
        saveGitConfig(dbName, config);
        saveStagedPaths(dbName, []);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        gitLog('branch-switch', `Switched from "${fromBranch}" to "${branchName}"`, 'info', null, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast(`Switched to branch "${branchName}"`);
    });
}
function gitNewBranch() {
    const dbName = db.name;
    const doCreate = (name) => {
        name = (name || '').trim();
        // Re-read state at submit time rather than trusting what was captured
        // when the dialog opened - the modal can sit open while something else
        // (another action, a window switch) changes the repo underneath it.
        const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
        const invalid = gitValidateBranchName(name);
        if (invalid) { gitModalError(invalid); return; }
        if (gitBranchExists(repo, name)) { gitModalError(`A branch named "${name}" already exists.`); return; }
        const sourceBranch = config.currentBranch;
        gitMoveRef(dbName, repo, name, repo.refs[sourceBranch] || null, `Branch created from "${sourceBranch}"`);
        saveGitRepo(dbName, repo);
        config.currentBranch = name;
        saveGitConfig(dbName, config);
        gitModalClose();
        window.renderGitPanel();
        gitLog('branch-create', `Created branch "${name}" from "${sourceBranch}"`, 'success', { branch: name, from: sourceBranch }, dbName);
        if (window.showSuccessToast) window.showSuccessToast(`Created branch "${name}"`);
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'New Branch', inputType: 'text', inputValue: '', placeholder: 'Branch name', submitText: 'Create' }, doCreate);
    else { const n = prompt('New branch name:'); if (n) doCreate(n); }
}
function gitRenameBranch() {
    const dbName = db.name;
    const oldName = getGitConfig(dbName).currentBranch;
    const doRename = (newName) => {
        newName = (newName || '').trim();
        const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
        if (newName === oldName) { gitModalClose(); return; } // nothing to change - just dismiss
        const invalid = gitValidateBranchName(newName);
        if (invalid) { gitModalError(invalid); return; }
        if (gitBranchExists(repo, newName)) { gitModalError(`A branch named "${newName}" already exists.`); return; }
        if (!gitBranchExists(repo, oldName)) { gitModalError(`Branch "${oldName}" no longer exists.`); return; }
        const movedSha = repo.refs[oldName];
        repo.refs[newName] = movedSha;
        delete repo.refs[oldName];
        saveGitRepo(dbName, repo);
        // Carry the old name's reflog history forward under the new name
        // (a rename shouldn't orphan it), then add one entry marking the
        // rename itself. The old name's reflog key is left in place, same
        // reasoning as a branch delete: still recoverable if needed.
        const oldHistory = gitGetReflog(dbName, oldName);
        if (oldHistory.length) localStorage.setItem(gitReflogKey(dbName, newName), JSON.stringify(oldHistory));
        let renamedEntries = gitGetReflog(dbName, newName);
        renamedEntries.push({ id: gitNewId('rl'), ts: Date.now(), branch: newName, from: movedSha, to: movedSha, reason: `Renamed from "${oldName}"` });
        if (renamedEntries.length > GIT_REFLOG_MAX) renamedEntries = renamedEntries.slice(-GIT_REFLOG_MAX);
        localStorage.setItem(gitReflogKey(dbName, newName), JSON.stringify(renamedEntries));
        // Only repoint "current" if we renamed the branch that IS current; if the
        // user switched branches while this dialog was open, leave theirs alone.
        if (config.currentBranch === oldName) config.currentBranch = newName;
        saveGitConfig(dbName, config);
        const pending = gitGetPendingMerge(dbName);
        if (pending && pending.targetBranch === oldName) { pending.targetBranch = newName; gitSavePendingMerge(dbName, pending); }
        const pendingRebase = gitGetPendingRebase(dbName);
        if (pendingRebase && pendingRebase.branch === oldName) { pendingRebase.branch = newName; gitSavePendingRebase(dbName, pendingRebase); }
        gitModalClose();
        window.renderGitPanel();
        gitLog('branch-rename', `Renamed branch "${oldName}" to "${newName}"`, 'success', { from: oldName, to: newName }, dbName);
        if (window.showSuccessToast) window.showSuccessToast(`Renamed branch to "${newName}"`);
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'Rename Branch', inputType: 'text', inputValue: oldName, placeholder: 'New branch name', submitText: 'Rename' }, doRename);
    else { const n = prompt('New name:', oldName); if (n) doRename(n); }
}
// Creates a lightweight tag at a given commit (defaults to the current
// branch's tip when no sha is passed - "tag what I have right now", the
// common case). A single-input dialog, same shape as New Branch - kept
// deliberately simple since a lightweight tag is just a name.
function gitNewTag(atSha) {
    const dbName = db.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const targetSha = atSha || repo.refs[config.currentBranch];
    if (!targetSha) { gitToast('Nothing to tag yet - make a commit first'); return; }
    const doCreate = (name) => {
        const result = gitCreateTag(dbName, (name || '').trim(), targetSha, null);
        if (result.error) { gitModalError(result.error); return; }
        gitModalClose();
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast(`Created tag "${(name || '').trim()}"`);
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'New Tag', inputType: 'text', inputValue: '', placeholder: 'v1.0.0', submitText: 'Create' }, doCreate);
    else { const n = prompt('Tag name:'); if (n) doCreate(n); }
}
// Annotated tag: real git's own two-part flow (name, then a message) done
// as two chained single-input dialogs rather than fighting the shared
// modal component (which has no generic two-text-field mode) into
// something it wasn't built for.
function gitNewAnnotatedTag(atSha) {
    const dbName = db.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const targetSha = atSha || repo.refs[config.currentBranch];
    if (!targetSha) { gitToast('Nothing to tag yet - make a commit first'); return; }
    const doCreateName = (name) => {
        name = (name || '').trim();
        const invalid = gitValidateBranchName(name);
        if (invalid) { gitModalError(invalid); return; }
        if (gitTagExists(getGitRepo(dbName), name)) { gitModalError(`Tag "${name}" already exists.`); return; }
        gitModalClose();
        const doCreateMessage = (message) => {
            const authorFields = gitAuthorFields(dbName);
            const result = gitCreateTag(dbName, name, targetSha, { message: (message || '').trim(), tagger: authorFields.author, timestamp: Date.now() });
            if (result.error) { gitModalError(result.error); return; }
            gitModalClose();
            window.renderGitPanel();
            if (window.showSuccessToast) window.showSuccessToast(`Created annotated tag "${name}"`);
        };
        if (window.showCustomModal) window.showCustomModal({ title: `Tag Message for "${name}"`, inputType: 'text', inputValue: '', placeholder: 'Release notes, e.g. "First stable release"', submitText: 'Create Tag' }, doCreateMessage);
        else { const m = prompt('Tag message:'); doCreateMessage(m || ''); }
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'New Annotated Tag', inputType: 'text', inputValue: '', placeholder: 'v1.0.0', submitText: 'Next' }, doCreateName);
    else { const n = prompt('Tag name:'); if (n) doCreateName(n); }
}
function gitDeleteBranch(branchName) {
    const dbName = db.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    if (Object.keys(repo.refs).length <= 1) { if (window.showSuccessToast) window.showSuccessToast("Can't delete the only branch"); return; }
    if (!gitBranchExists(repo, branchName)) return;
    const pending = gitGetPendingMerge(dbName);
    if (pending && (branchName === pending.targetBranch || branchName === pending.sourceBranch)) {
        gitToast('Finish or abort the in-progress merge before deleting this branch');
        return;
    }
    const pendingRebase = gitGetPendingRebase(dbName);
    if (pendingRebase && (branchName === pendingRebase.branch || branchName === pendingRebase.ontoBranch)) {
        gitToast('Finish or abort the in-progress rebase before deleting this branch');
        return;
    }
    const doDelete = () => {
        delete repo.refs[branchName];
        if (config.currentBranch === branchName) config.currentBranch = Object.keys(repo.refs)[0];
        saveGitRepo(dbName, repo);
        saveGitConfig(dbName, config);
        gitLog('branch-delete', `Deleted branch "${branchName}"`, 'info', null, dbName);
        window.renderGitPanel();
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'Delete Branch', text: `Delete branch "${gitEsc(branchName)}"? Its commits stay in the repo as long as another branch can still reach them.`, submitText: 'Delete' }, doDelete);
    else if (confirm(`Delete branch "${branchName}"?`)) doDelete();
}
function gitMergeBranch(sourceBranchName) {
    const database = db; const dbName = database.name;
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const targetBranchName = config.currentBranch;
    if (!sourceBranchName || sourceBranchName === targetBranchName || !gitBranchExists(repo, sourceBranchName)) return;
    gitConfirmIfDirty(`Merging will discard your uncommitted changes first. Continue?`, async () => {
        const targetSha = repo.refs[targetBranchName] || null;
        const sourceSha = repo.refs[sourceBranchName] || null;
        const base = gitMergeBase(repo, targetSha, sourceSha);

        // Fast-forward: target hasn't moved since the branches shared history,
        // so the merge is just "target catches up to source" - move the ref,
        // no merge commit, exactly like real git (and unlike a normal merge,
        // this can't have a conflict, since target contributes no changes of
        // its own since the base).
        if (base === targetSha && sourceSha !== targetSha) {
            gitMoveRef(dbName, repo, targetBranchName, sourceSha, `Fast-forward merge from "${sourceBranchName}"`);
            saveGitRepo(dbName, repo);
            await gitApplyTree(database, gitComputeHeadTree(repo, targetBranchName));
            saveStagedPaths(dbName, []);
            if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
            gitLog('merge', `Fast-forwarded "${targetBranchName}" to "${sourceBranchName}"`, 'success', { source: sourceBranchName, target: targetBranchName, fastForward: true }, dbName);
            window.renderGitPanel();
            if (window.showSuccessToast) window.showSuccessToast(`Fast-forwarded "${targetBranchName}" to "${sourceBranchName}"`);
            return;
        }

        const targetHead = gitComputeHeadTree(repo, targetBranchName);
        const sourceHead = gitComputeHeadTree(repo, sourceBranchName);
        const baseHead = gitComputeHeadTree(repo, base); // empty tree if base is null (unrelated histories)
        const { merged, conflicts } = gitThreeWayMerge(baseHead, targetHead, sourceHead, targetBranchName, sourceBranchName);
        const mergeChanges = gitComputeChanges(merged, targetHead);
        if (mergeChanges.length === 0 && conflicts.length === 0) { if (window.showSuccessToast) window.showSuccessToast('Already up to date'); return; }

        await gitApplyTree(database, merged);
        saveStagedPaths(dbName, []);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();

        if (conflicts.length > 0) {
            // Don't commit yet - leave the merge pending (mirrors real git's
            // MERGE_HEAD) with conflict markers sitting in the working files
            // for the user to resolve, same as a real conflicted `git merge`.
            gitSavePendingMerge(dbName, {
                targetBranch: targetBranchName, sourceBranch: sourceBranchName,
                targetSha, sourceSha, baseSha: base,
                conflictPaths: conflicts.map(c => c.path),
                unresolvedBinary: conflicts.filter(c => c.kind === 'binary').map(c => c.path),
                startedAt: Date.now()
            });
            gitLog('merge', `Merge of "${sourceBranchName}" into "${targetBranchName}" has ${conflicts.length} conflict(s) - resolve and commit to finish`, 'error', { source: sourceBranchName, target: targetBranchName, conflicts: conflicts.length }, dbName);
            window.renderGitPanel();
            gitNotifyConflict(dbName, 'Merge conflicts need your attention',
                `Merging "${sourceBranchName}" into "${targetBranchName}" left ${conflicts.length} conflict(s). Open Source Control, resolve them in the Changes tab, then commit to finish.`,
                `${conflicts.length} conflict(s) - resolve in Changes tab`);
            return;
        }

        const files = mergeChanges.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
        const sha = await gitCreateCommitObject(repo, `Merge branch '${sourceBranchName}' into '${targetBranchName}'`, [targetSha, sourceSha], files, gitAuthorFields(dbName));
        gitMoveRef(dbName, repo, targetBranchName, sha, `Merge "${sourceBranchName}" into "${targetBranchName}"`);
        saveGitRepo(dbName, repo);
        gitLog('merge', `Merged "${sourceBranchName}" into "${targetBranchName}" (${mergeChanges.length} file(s))`, 'success', { source: sourceBranchName, target: targetBranchName, sha: gitShortSha(sha) }, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast(`Merged "${sourceBranchName}" into "${targetBranchName}"`);
    });
}
// Resolves one conflicted path during a pending merge. `choice` is 'mine'
// (target branch's version - real git's "ours" from the perspective of the
// branch being merged into), 'theirs' (source branch's version), or 'both'
// (text conflicts only: keep the file with markers stripped but both sides'
// content concatenated, for the common case where a conflict is really just
// two independent additions to the same file, like two new import lines).
async function gitResolveConflict(path, choice) {
    const database = db; const dbName = database.name;
    const pendingMerge = gitGetPendingMerge(dbName);
    const pendingRebase = gitGetPendingRebase(dbName);
    const pending = (pendingMerge && pendingMerge.conflictPaths.includes(path)) ? { kind: 'merge', state: pendingMerge }
        : (pendingRebase && pendingRebase.conflictPaths.includes(path)) ? { kind: 'rebase', state: pendingRebase, targetSha: pendingRebase.newTip, sourceSha: pendingRebase.originalShas[pendingRebase.nextIndex] }
        : null;
    if (!pending) return;
    const targetSha = pending.kind === 'rebase' ? pending.targetSha : pending.state.targetSha;
    const sourceSha = pending.kind === 'rebase' ? pending.sourceSha : pending.state.sourceSha;
    const repo = getGitRepo(dbName);
    const targetTree = gitComputeHeadTree(repo, targetSha);
    const sourceTree = gitComputeHeadTree(repo, sourceSha);
    const mine = targetTree.get(path) || null;
    const theirs = sourceTree.get(path) || null;

    let resolved; // null means "delete this file"
    if (choice === 'mine') resolved = mine;
    else if (choice === 'theirs') resolved = theirs;
    else if (choice === 'both' && mine && theirs) resolved = { content: mine.content + '\n' + theirs.content, encoding: 'text', name: mine.name };
    else return;

    const workingTree = await gitGetWorkingTree(database);
    if (resolved) workingTree.set(path, resolved); else workingTree.delete(path);
    await gitApplyTree(database, workingTree);
    if (typeof loadFilesFromDB === 'function') loadFilesFromDB();

    if (pending.state.unresolvedBinary && pending.state.unresolvedBinary.includes(path)) {
        pending.state.unresolvedBinary = pending.state.unresolvedBinary.filter(p => p !== path);
        if (pending.kind === 'rebase') gitSavePendingRebase(dbName, pending.state);
        else gitSavePendingMerge(dbName, pending.state);
    }
    window.renderGitPanel();
}
// Backs fully out of a pending merge: the working tree reverts to exactly
// what the target branch looked like before the merge was attempted (its
// ref never moved during a conflicted merge, so this is just re-applying its
// current HEAD tree), and the pending-merge record is cleared. Mirrors
// `git merge --abort`.
function gitAbortMerge() {
    const database = db; const dbName = database.name;
    const pending = gitGetPendingMerge(dbName);
    if (!pending) return;
    const doAbort = async () => {
        const repo = getGitRepo(dbName);
        await gitApplyTree(database, gitComputeHeadTree(repo, pending.targetBranch));
        saveStagedPaths(dbName, []);
        gitSavePendingMerge(dbName, null);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        gitLog('merge-abort', `Aborted merge of "${pending.sourceBranch}" into "${pending.targetBranch}"`, 'info', null, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast('Merge aborted');
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'Abort Merge', text: 'This discards the in-progress merge and any conflict resolutions made so far, restoring the branch to how it was before merging.', submitText: 'Abort Merge' }, doAbort);
    else if (confirm('Abort the in-progress merge?')) doAbort();
}
// Replays the current branch's own commits (since it diverged from
// ontoBranchName) on top of ontoBranchName's tip, one at a time - real
// git's `rebase`. Each replayed commit gets a genuinely NEW sha (its parent
// changed, so its content-addressed hash changes too - this is exactly why
// rebase rewrites history, not a simplification of it), built with the same
// real 3-way merge every other operation here uses, so a genuine conflict
// mid-replay gets real conflict markers instead of silently picking a side.
//
// Deliberately not offered on a branch with no divergence to replay (either
// side of gitMergeBase already containing the other) - there's nothing
// meaningful to rebase in that case, matching real git's own "already up to
// date" / fast-forward-instead behavior.
function gitRebaseBranch(ontoBranchName) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before rebasing'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before starting another'); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const branchName = config.currentBranch;
    if (!ontoBranchName || ontoBranchName === branchName || !gitBranchExists(repo, ontoBranchName)) return;

    gitConfirmIfDirty(`Rebasing will discard your uncommitted changes first. Continue?`, async () => {
        const currentTip = repo.refs[branchName] || null;
        const ontoTip = repo.refs[ontoBranchName] || null;
        const base = gitMergeBase(repo, currentTip, ontoTip);

        if (base === currentTip) { if (window.showSuccessToast) window.showSuccessToast(`"${branchName}" has no commits of its own to replay onto "${ontoBranchName}"`); return; }
        if (base === ontoTip) { if (window.showSuccessToast) window.showSuccessToast(`"${branchName}" is already ahead of "${ontoBranchName}" - nothing to rebase`); return; }

        // Oldest-first: the order commits must be REPLAYED in, not the
        // newest-first order gitWalkAncestors normally returns them in.
        const chain = gitWalkAncestors(repo, currentTip);
        const baseIdx = chain.indexOf(base);
        const toReplay = (baseIdx === -1 ? chain : chain.slice(0, baseIdx)).reverse();

        gitSavePendingRebase(dbName, {
            branch: branchName, ontoBranch: ontoBranchName, ontoTipAtStart: ontoTip,
            originalShas: toReplay, newTip: ontoTip, nextIndex: 0,
            conflictPaths: [], unresolvedBinary: [], startedAt: Date.now()
        });
        await gitContinueRebase();
    });
}
// Applies as many of a pending rebase's remaining commits as replay cleanly,
// stopping (and leaving pending-rebase state in place, with conflict
// markers in the working tree) the moment one doesn't. Called both to kick
// a rebase off and to resume it after the user resolves a conflict and
// clicks Continue - real git's own `git rebase --continue` shape.
async function gitContinueRebase() {
    const database = db; const dbName = database.name;
    let pending = gitGetPendingRebase(dbName);
    if (!pending) return;
    const repo = getGitRepo(dbName);
    const authorFields = gitAuthorFields(dbName);

    // If resuming after a resolved conflict, the working tree now holds the
    // resolution for originalShas[nextIndex] - fold it into newTip as that
    // commit's actual replayed result before moving on to the next one.
    if (pending.conflictPaths.length > 0) {
        const workingTree = await gitGetWorkingTree(database);
        const unresolved = gitFindUnresolvedConflicts({ conflictPaths: pending.conflictPaths, unresolvedBinary: pending.unresolvedBinary }, workingTree);
        if (unresolved.length > 0) { gitToast(`${unresolved.length} unresolved conflict(s) - resolve them before continuing the rebase`); return; }
        const originalSha = pending.originalShas[pending.nextIndex];
        const originalCommit = repo.objects[originalSha];
        const beforeTree = gitComputeHeadTree(repo, pending.newTip);
        const changes = gitComputeChanges(workingTree, beforeTree);
        const files = changes.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
        const newSha = await gitCreateCommitObject(repo, originalCommit.message, [pending.newTip], files, authorFields);
        pending.newTip = newSha;
        pending.nextIndex++;
        pending.conflictPaths = []; pending.unresolvedBinary = [];
        saveGitRepo(dbName, repo);
    }

    for (; pending.nextIndex < pending.originalShas.length; pending.nextIndex++) {
        const originalSha = pending.originalShas[pending.nextIndex];
        const originalCommit = repo.objects[originalSha];
        const baseTree = gitComputeHeadTree(repo, originalCommit.parents[0] || null);
        const oursTree = gitComputeHeadTree(repo, pending.newTip);
        const theirsTree = gitComputeHeadTree(repo, originalSha);
        const { merged, conflicts } = gitThreeWayMerge(baseTree, oursTree, theirsTree, pending.ontoBranch, gitShortSha(originalSha));

        if (conflicts.length > 0) {
            await gitApplyTree(database, merged);
            saveStagedPaths(dbName, []);
            if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
            pending.conflictPaths = conflicts.map(c => c.path);
            pending.unresolvedBinary = conflicts.filter(c => c.kind === 'binary').map(c => c.path);
            saveGitRepo(dbName, repo);
            gitSavePendingRebase(dbName, pending);
            gitLog('rebase', `Rebase of "${pending.branch}" onto "${pending.ontoBranch}" paused: commit ${pending.nextIndex + 1}/${pending.originalShas.length} (${gitShortSha(originalSha)}) has ${conflicts.length} conflict(s)`, 'error', { branch: pending.branch, onto: pending.ontoBranch, conflicts: conflicts.length }, dbName);
            window.renderGitPanel();
            gitNotifyConflict(dbName, 'Rebase paused on a conflict',
                `Rebasing "${pending.branch}" onto "${pending.ontoBranch}" stopped at commit ${pending.nextIndex + 1}/${pending.originalShas.length}: ${conflicts.length} conflict(s). Open Source Control, resolve them in the Changes tab, then continue the rebase.`,
                `Rebase paused: ${conflicts.length} conflict(s) on commit ${pending.nextIndex + 1}/${pending.originalShas.length}`);
            return;
        }

        const changes = gitComputeChanges(merged, oursTree);
        const files = changes.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
        const newSha = changes.length > 0 || !pending.newTip
            ? await gitCreateCommitObject(repo, originalCommit.message, [pending.newTip], files, authorFields)
            : pending.newTip; // this original commit's changes are already fully present (identical to something upstream) - don't create an empty duplicate
        pending.newTip = newSha;
    }

    // Every commit replayed cleanly - finish the rebase: move the branch ref,
    // sync the working tree to match, and clear the pending state.
    gitMoveRef(dbName, repo, pending.branch, pending.newTip, `Rebase onto "${pending.ontoBranch}" (${pending.originalShas.length} commit(s) replayed)`);
    saveGitRepo(dbName, repo);
    await gitApplyTree(database, gitComputeHeadTree(repo, pending.branch));
    saveStagedPaths(dbName, []);
    if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
    const replayedCount = pending.originalShas.length;
    gitSavePendingRebase(dbName, null);
    if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
    gitLog('rebase', `Rebased "${pending.branch}" onto "${pending.ontoBranch}" (${replayedCount} commit(s) replayed)`, 'success', { branch: pending.branch, onto: pending.ontoBranch, count: replayedCount }, dbName);
    window.renderGitPanel();
    if (window.showSuccessToast) window.showSuccessToast(`Rebased onto "${pending.ontoBranch}"`);
}
// Backs fully out of a pending rebase: the working tree and branch ref
// revert to exactly what they were before the rebase started (the branch's
// own ref never moves until every commit has replayed cleanly, so this is
// just re-applying the branch's still-current HEAD tree). Mirrors
// `git rebase --abort`.
async function gitReflogRecover(sha) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before recovering from the reflog'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before recovering from the reflog'); return; }
    const config = getGitConfig(dbName);
    const doRecover = async () => {
        const result = gitRecoverRef(dbName, config.currentBranch, sha);
        if (result.error) { gitToast(result.error); return; }
        const repo = getGitRepo(dbName);
        await gitApplyTree(database, gitComputeHeadTree(repo, config.currentBranch));
        saveStagedPaths(dbName, []);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast(`Recovered "${config.currentBranch}" to ${gitShortSha(sha)}`);
    };
    const text = `This moves "${gitEsc(config.currentBranch)}" back to ${gitShortSha(sha)} and updates your files to match, discarding any uncommitted changes. This is itself recorded in the reflog, so it can be undone the same way if needed.`;
    if (window.showCustomModal) window.showCustomModal({ title: 'Recover from Reflog', text, submitText: 'Recover' }, doRecover);
    else if (confirm(text)) doRecover();
}
function gitAbortRebase() {
    const database = db; const dbName = database.name;
    const pending = gitGetPendingRebase(dbName);
    if (!pending) return;
    const doAbort = async () => {
        const repo = getGitRepo(dbName);
        await gitApplyTree(database, gitComputeHeadTree(repo, pending.branch));
        saveStagedPaths(dbName, []);
        gitSavePendingRebase(dbName, null);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        gitLog('rebase-abort', `Aborted rebase of "${pending.branch}" onto "${pending.ontoBranch}"`, 'info', null, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast('Rebase aborted');
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'Abort Rebase', text: 'This discards the in-progress rebase and any conflict resolutions made so far. The branch stays exactly as it was before rebasing.', submitText: 'Abort Rebase' }, doAbort);
    else if (confirm('Abort the in-progress rebase?')) doAbort();
}
async function gitStashChanges() {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before stashing'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before stashing'); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const headTree = gitComputeHeadTree(repo, config.currentBranch);
    const workingTree = await gitGetWorkingTree(database);
    const changes = gitFilterIgnoredAdds(gitComputeChanges(workingTree, headTree), gitGetIgnoreRules(workingTree));
    if (changes.length === 0) { if (window.showSuccessToast) window.showSuccessToast('Nothing to stash'); return; }
    repo.stash = repo.stash || [];
    repo.stash.push({
        id: gitNewId('s'), branch: config.currentBranch, timestamp: Date.now(),
        files: changes.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }))
    });
    saveGitRepo(dbName, repo);
    await gitApplyTree(database, headTree);
    saveStagedPaths(dbName, []);
    if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
    gitLog('stash', `Stashed ${changes.length} file(s) from "${config.currentBranch}"`, 'info', null, dbName);
    window.renderGitPanel();
    if (window.showSuccessToast) window.showSuccessToast('Changes stashed');
}
async function gitPopStash(stashId) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before applying a stash'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before applying a stash'); return; }
    const repo = getGitRepo(dbName);
    const stash = (repo.stash || []).find(s => s.id === stashId);
    if (!stash) return;
    const workingTree = await gitGetWorkingTree(database);
    const applied = new Map();
    workingTree.forEach((data, path) => applied.set(path, data));
    stash.files.forEach(f => {
        if (f.status === 'deleted') applied.delete(f.path);
        else applied.set(f.path, { content: f.content, encoding: f.encoding, name: f.name });
    });
    await gitApplyTree(database, applied);
    repo.stash = repo.stash.filter(s => s.id !== stashId);
    saveGitRepo(dbName, repo);
    if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
    gitLog('stash-pop', `Applied and removed stash from "${stash.branch}"`, 'info', null, dbName);
    window.renderGitPanel();
    if (window.showSuccessToast) window.showSuccessToast('Stash applied');
}
function gitDropStash(stashId) {
    const dbName = db.name;
    const repo = getGitRepo(dbName);
    repo.stash = (repo.stash || []).filter(s => s.id !== stashId);
    saveGitRepo(dbName, repo);
    gitLog('stash-drop', `Dropped a stash`, 'info', { stashId }, dbName);
    window.renderGitPanel();
}
async function gitRestoreToCommit(commitId) {
    const database = db; const dbName = database.name;
    if (gitGetPendingMerge(dbName)) { gitToast('Finish or abort the in-progress merge before restoring to a commit'); return; }
    if (gitGetPendingRebase(dbName)) { gitToast('Finish or abort the in-progress rebase before restoring to a commit'); return; }
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const targetTree = gitComputeTreeAtCommit(repo, config.currentBranch, commitId);
    const doRestore = async () => {
        await gitApplyTree(database, targetTree);
        saveStagedPaths(dbName, []);
        if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
        gitLog('restore', `Restored working files to commit ${commitId}`, 'info', { commitId }, dbName);
        window.renderGitPanel();
        if (window.showSuccessToast) window.showSuccessToast('Files restored to selected commit');
    };
    if (window.showCustomModal) {
        window.showCustomModal({ title: 'Restore Files', text: 'This overwrites your current files (uncommitted changes will be lost) to match this commit. Your commit history is kept as-is. Continue?', submitText: 'Restore' }, doRestore);
    } else if (confirm('Restore files to this commit? Uncommitted changes will be lost.')) doRestore();
}
function gitToggleCommitExpand(commitId) {
    // Goes through gitUi() (like every other accessor) rather than reading
    // window.gitStateRegistry[winId] directly - that skipped the lazy-init
    // guard, so a call for a winId that hadn't been through gitUi() yet would
    // throw on the undefined .expandedCommits instead of just creating it.
    const uiState = gitUi();
    if (uiState.expandedCommits.has(commitId)) uiState.expandedCommits.delete(commitId);
    else uiState.expandedCommits.add(commitId);
    window.renderGitPanel();
}
function gitSwitchTab(tab) {
    if (!GIT_TABS.includes(tab)) return;
    const ui = gitUi();
    const sidebar = document.getElementById('sourceControlSidebar');
    if (sidebar) gitSnapshotInputs(sidebar, ui);
    ui.activeTab = tab;
    window.renderGitPanel();
}

// --- GitHub integration -----------------------------------------------------
// Split across two tabs, mirroring `git config --global` vs `--local`:
//   Config -> the personal access token, the verified GitHub profile it belongs
//             to (account-level), and this repository's local commit identity
//             (synced with the app's own profile, see settings-profile.js).
//   Remote -> everything that talks to a repository: push/pull, your
//             repositories, new repository, fork, issues, pull requests and the
//             Source Control log.
// This is a browser IDE with no server of its own, so everything goes through
// the GitHub REST API with the token.
//
// Scoped per window/profile (codemini_git_gh_token_<winId>), not global. Every
// other piece of state in this app - recycle bin, clipboard, recently closed,
// folder stack, sidebar width - is isolated per window, and an isolated
// Profile window is meant to be its own separate persona. A single shared
// token broke that: connecting GitHub in one profile silently gave every
// other window/profile in the same browser the ability to push, pull, create
// repositories and open issues/PRs under that same account with no prompt.
// A fixed, un-suffixed legacy key is read once as a fallback (see
// gitMigrateLegacyToken) so a token saved by an older version isn't just
// dropped on upgrade - it's migrated into the *current* window's own slot
// the first time Source Control runs after updating, then removed.
const GIT_TOKEN_KEY_LEGACY = 'codemini_git_gh_token';
const GIT_PROFILE_KEY_LEGACY = 'codemini_git_gh_profile';
function gitTokenKey(winId) { return `codemini_git_gh_token_${winId || gitWinId()}`; }
function gitProfileKey(winId) { return `codemini_git_gh_profile_${winId || gitWinId()}`; }
// Runs once per page load. A token saved before this change lived under the
// old un-suffixed key with no owner - rather than either discarding it or
// leaving it reachable from every window, it's handed to whichever window
// happens to load Source Control first after the upgrade (that window's
// existing behavior doesn't change) and removed from the shared key so no
// other window can pick it up afterwards.
function gitMigrateLegacyToken() {
    if (window._gitLegacyMigrationDone) return;
    window._gitLegacyMigrationDone = true;
    try {
        const legacyToken = localStorage.getItem(GIT_TOKEN_KEY_LEGACY);
        if (legacyToken === null) return;
        const winId = gitWinId();
        if (localStorage.getItem(gitTokenKey(winId)) === null) {
            localStorage.setItem(gitTokenKey(winId), legacyToken);
            const legacyProfile = localStorage.getItem(GIT_PROFILE_KEY_LEGACY);
            if (legacyProfile !== null) localStorage.setItem(gitProfileKey(winId), legacyProfile);
        }
        localStorage.removeItem(GIT_TOKEN_KEY_LEGACY);
        localStorage.removeItem(GIT_PROFILE_KEY_LEGACY);
    } catch (e) {}
}
const GIT_LOG_MAX = 300;
const GIT_TABS = ['changes', 'history', 'remote', 'config'];
const GIT_SECTION_DEFAULTS = { repos: true };

// --- Per-window UI state ------------------------------------------------------
// drafts:   what the user has typed into form fields (survives re-renders, tab
//           switches and async completions, which all rebuild the sidebar HTML)
// sections: which collapsible Remote-tab sections are open
// results:  the last success/error/progress message of each form
// busy:     in-flight flags, so a double-click can't fire a request twice
function gitWinId() { return localStorage.getItem('codemini_active_window') || 'win_default'; }
function gitUi() {
    window.gitStateRegistry = window.gitStateRegistry || {};
    const winId = gitWinId();
    let ui = window.gitStateRegistry[winId];
    if (!ui) ui = window.gitStateRegistry[winId] = { activeTab: 'changes', expandedCommits: new Set() };
    if (!ui.expandedCommits) ui.expandedCommits = new Set();
    if (!ui.drafts) ui.drafts = {};
    if (!ui.sections) ui.sections = {};
    if (!ui.results) ui.results = {};
    if (!ui.busy) ui.busy = {};
    return ui;
}
// Account-level GitHub state (repo list, branch lists, auto-verify tracking) -
// keyed per window/profile, same as gitUi() above, since the token itself now
// is too: window A's fetched repo/branch lists must never appear while window
// B is active, even for a moment during a render that runs before a fresh
// fetch completes.
function gitGHState() {
    window._gitGHRegistry = window._gitGHRegistry || {};
    const winId = gitWinId();
    if (!window._gitGHRegistry[winId]) {
        window._gitGHRegistry[winId] = {
            repos: { items: [], page: 0, hasMore: false, loading: false, loaded: false, error: null, scope: 'owner' },
            branches: {}, branchesTried: {}, autoVerifyTried: null
        };
    }
    return window._gitGHRegistry[winId];
}
function gitResetGithubCaches() {
    if (window._gitGHRegistry) delete window._gitGHRegistry[gitWinId()];
}
function gitSetResult(ui, key, level, text, extra) { ui.results[key] = Object.assign({ level, text: String(text == null ? '' : text) }, extra || {}); }
// Success banners live in sections that are always rendered (GitHub Account,
// push/pull), unlike New Repository/Issue/PR's results, which get hidden the
// moment their collapsible section is closed - so nothing was ever clearing
// these, and they sat there until a full page reload. gitToast already gives
// the same confirmation as a real toast, so once that's had time to be seen
// (matching its own 3s auto-dismiss - see showSuccessToast in app.js), clear
// the inline copy too. Reference-compares against the object gitSetResult
// just created so a newer result (another action, an error) isn't clobbered
// if it lands before this timer fires.
function gitAutoClearResult(ui, key, delay) {
    const snapshot = ui.results[key];
    setTimeout(() => {
        if (ui.results[key] === snapshot) { delete ui.results[key]; window.renderGitPanel(); }
    }, delay || 3000);
}
function gitSectionOpen(ui, name) { return ui.sections[name] !== undefined ? !!ui.sections[name] : !!GIT_SECTION_DEFAULTS[name]; }
function gitDraft(ui, id, fallback) { return ui.drafts[id] !== undefined ? ui.drafts[id] : fallback; }
// Live DOM value first (the field is on screen when its button is clicked),
// falling back to the saved draft.
function gitFieldValue(id, fallback) {
    const el = document.getElementById(id);
    if (el && typeof el.value === 'string') return el.value;
    const d = gitUi().drafts[id];
    return d !== undefined ? String(d) : (fallback || '');
}
function gitFieldChecked(id, fallback) {
    const el = document.getElementById(id);
    if (el && typeof el.checked === 'boolean') return el.checked;
    const d = gitUi().drafts[id];
    return d !== undefined ? !!d : !!fallback;
}
// Copies the current value of every [data-git-keep] field into ui.drafts. Called
// synchronously right before the sidebar HTML is replaced, so whatever the user
// typed a millisecond ago is what the new HTML is built from.
function gitSnapshotInputs(sidebar, ui) {
    sidebar.querySelectorAll('[data-git-keep]').forEach(el => {
        if (!el.id) return;
        ui.drafts[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    });
}

// --- Small helpers ------------------------------------------------------------
// WHERE THE GITHUB TOKEN LIVES
//   1. Encrypted with Shield's device key, in localStorage under gitEncKey(winId). This is the normal home. No
//      password is involved, so the token stays usable after My Keys locks. It protects against a copy of the
//      browser's storage or a leaked backup; it does not protect against someone using this open browser, or
//      script running in this page (see SECURITY.md).
//   2. The My Keys vault. Used when the device key is not available (no IndexedDB), and it is where the previous
//      version put the token. A token found there moves to the device key the next time My Keys is unlocked.
//   3. Plain text under gitTokenKey(winId): only what very old versions saved. It is encrypted with the device
//      key the first time this page loads, and no unlock is needed for that.
// gitGetToken() has to stay synchronous (many callers) but decrypting is async, so the decrypted token is held in
// gitTokenCache for the life of the page (the "session cache"). It is filled by gitHydrateToken(), lives in memory
// only, is per window/profile, and is NOT emptied when My Keys locks.
function gitKeys() { return window.CodeMiniKeys || null; }
function gitDevice() { const s = window.CodeMiniShield; return s && s.device && s.device.supported ? s.device : null; }
function gitEncKey(winId) { return `codemini_git_gh_tokenenc_${winId || gitWinId()}`; }
// The purpose is authenticated by Shield, so one window's record does not open as another window's token.
function gitTokenPurpose(winId) { return `github-token:${winId}`; }
const gitTokenCache = {};    // winId -> decrypted token (memory only)
const gitTokenGen = {};      // winId -> counter, bumped on every save/remove so an older async load cannot overwrite a newer token
const gitTokenLoad = {};     // winId -> Promise of the first load
const gitTokenLoaded = {};   // winId -> true once that load has finished
const gitTokenProblem = {};  // winId -> 'lost' (cannot be decrypted any more) | 'unavailable' (key storage unreachable)
function gitBumpTokenGen(winId) { gitTokenGen[winId] = (gitTokenGen[winId] || 0) + 1; }
function gitHasEncRecord(winId) { try { return localStorage.getItem(gitEncKey(winId)) !== null; } catch (e) { return false; } }
function gitVaultToken() {
    try { const k = gitKeys(); return (k && k.getSecret && k.getSecret('github-token')) || ''; } catch (e) { return ''; }
}
function gitLegacyPlainToken() {
    try { return localStorage.getItem(gitTokenKey()) || ''; } catch (e) { return ''; }
}
function gitGetToken() {
    gitMigrateLegacyToken();
    return gitTokenCache[gitWinId()] || gitVaultToken() || gitLegacyPlainToken();
}
// True while the encrypted token for this window exists but has not been decrypted yet (the first moments of a page).
function gitTokenLoading() {
    const w = gitWinId();
    return !!(gitDevice() && !gitTokenCache[w] && !gitTokenLoaded[w] && gitHasEncRecord(w));
}
// True when this window has connected GitHub before but the token cannot be read right now: it is still in My Keys
// (saved by the previous version, or the device key is unavailable) and My Keys is locked.
function gitTokenLocked() {
    const k = gitKeys(), w = gitWinId();
    return !!(k && !k.isUnlocked() && !gitTokenCache[w] && !gitLegacyPlainToken() && !gitTokenLoading() && !gitTokenProblem[w] && gitGetGhProfile());
}
function gitNoTokenMessage() {
    const p = gitTokenProblem[gitWinId()];
    if (p === 'lost') return 'The saved GitHub token can no longer be decrypted on this device. Add it again in the Config tab.';
    if (p === 'unavailable') return 'This browser\'s key storage cannot be reached, so the saved GitHub token cannot be read. Reload the page or add the token again in the Config tab.';
    if (gitTokenLoading()) return 'Still loading your saved GitHub token. Try again in a moment.';
    if (gitTokenLocked()) return gitDevice() ? 'Unlock My Keys once: your GitHub token is still stored there and will move to this device\'s key.' : 'Unlock My Keys to use your saved GitHub token.';
    return 'Connect your GitHub account in the Config tab first.';
}
function gitRequestVaultUnlock() { const k = gitKeys(); if (k && k.requestUnlock) k.requestUnlock(); }
// Seals `token` with the device key, writes it, and opens it back from storage to prove it round-trips. If anything
// fails the previous record (if any) is put back, so a failed save never destroys a working token. `gen` (optional)
// is the counter value the caller started with: if a newer save or removal happened meanwhile, nothing is written
// and false is returned.
async function gitStoreDevice(winId, token, gen) {
    const dev = gitDevice();
    if (!dev) throw new Error('The device key is not available.');
    const purpose = gitTokenPurpose(winId), key = gitEncKey(winId);
    const rec = await dev.seal(purpose, { t: token });
    if (gen !== undefined && (gitTokenGen[winId] || 0) !== gen) return false;
    const prev = localStorage.getItem(key);
    try {
        localStorage.setItem(key, JSON.stringify(rec));
        const back = await dev.open(purpose, JSON.parse(localStorage.getItem(key)));
        if (!back || back.t !== token) throw new Error('The stored token did not read back correctly.');
        return true;
    } catch (e) {
        try { if (prev === null) localStorage.removeItem(key); else localStorage.setItem(key, prev); } catch (x) { /* storage is unusable */ }
        throw e;
    }
}
// A record that nothing on this device can decrypt (browser data was partly cleared, or the record is damaged)
// cannot be fixed, so it is removed and the person is told to add the token again. A key store that merely cannot
// be reached right now is NOT treated that way: nothing is deleted, and it is tried again on the next load.
function gitTokenUnreadable(winId, e) {
    const code = e && e.code;
    if (code === 'storage' || code === 'unsupported') {
        gitTokenProblem[winId] = 'unavailable';
        gitLog('auth', 'This browser\'s key storage could not be reached, so the saved GitHub token cannot be read in this session', 'error');
        return;
    }
    try { localStorage.removeItem(gitEncKey(winId)); localStorage.removeItem(gitProfileKey(winId)); } catch (x) { /* nothing to remove */ }
    gitTokenProblem[winId] = 'lost';
    gitNotify({ id: 'git-token', title: 'GitHub token could not be read', text: 'The saved GitHub token can no longer be decrypted on this device, which usually means this browser\'s site data was partly cleared. Add the token again in the Config tab of Source Control.' });
    gitLog('auth', 'The saved GitHub token could not be decrypted and was removed; it needs to be added again', 'error');
}
// Fills the session cache for a window once per page load: decrypts the saved token, or encrypts a plain-text one.
function gitHydrateToken(winId) {
    winId = winId || gitWinId();
    if (gitTokenLoad[winId]) return gitTokenLoad[winId];
    // Starts on a later tick on purpose: the body can finish without awaiting anything, and it ends by redrawing the
    // panel, whose render calls gitHydrateToken() again. The promise has to be recorded before that happens.
    gitTokenLoad[winId] = Promise.resolve().then(async () => {
        const gen = gitTokenGen[winId] || 0, current = () => (gitTokenGen[winId] || 0) === gen;
        try {
            const dev = gitDevice();
            if (!dev) return;
            const raw = localStorage.getItem(gitEncKey(winId));
            if (raw !== null) {
                let v;
                try {
                    v = await dev.open(gitTokenPurpose(winId), JSON.parse(raw));
                    if (!v || typeof v.t !== 'string' || !v.t) throw new Error('damaged');
                } catch (e) { if (current()) gitTokenUnreadable(winId, e); return; }
                if (current()) gitTokenCache[winId] = v.t;
            } else {
                const plain = localStorage.getItem(gitTokenKey(winId));
                if (plain && await gitStoreDevice(winId, plain, gen)) {
                    gitTokenCache[winId] = plain;
                    localStorage.removeItem(gitTokenKey(winId));
                    gitLog('auth', 'Encrypted the saved GitHub token with this device\'s key (it was stored as plain text)', 'info');
                }
            }
        } catch (e) { /* the token stays where it was and this is tried again on the next load */ }
        finally { gitTokenLoaded[winId] = true; }
        gitMoveVaultTokenToDevice();
        if (winId === gitWinId() && typeof window.renderGitPanel === 'function') { try { window.renderGitPanel(); } catch (e) { /* panel not mounted */ } }
    });
    return gitTokenLoad[winId];
}
let gitMovingToken = false;
// Fallback only (no device key): a plain-text token moves into the My Keys vault the next time it is unlocked.
async function gitMoveTokenToVault() {
    const k = gitKeys();
    if (gitMovingToken || !k || !k.isUnlocked()) return;
    const legacy = gitLegacyPlainToken();
    if (!legacy) return;
    gitMovingToken = true;
    try {
        if (!gitVaultToken()) await k.setSecret('github-token', legacy);
        localStorage.removeItem(gitTokenKey());
        gitLog('auth', 'Moved the saved GitHub token into My Keys (encrypted)', 'info');
    } catch (e) { /* stays where it was; tried again next unlock */ }
    finally { gitMovingToken = false; }
}
// A token the previous version kept in the My Keys vault moves to the device key, then its vault copy is removed so
// the token lives in one place. The vault copy is only removed once the device copy is stored and read back, or
// when a device copy already exists (then the vault copy is the older one).
async function gitMoveVaultTokenToDevice() {
    const k = gitKeys(), winId = gitWinId();
    if (gitMovingToken || !gitDevice() || !k || !k.isUnlocked()) return;
    gitMovingToken = true;
    try {
        await gitHydrateToken(winId);
        if (gitWinId() !== winId || !k.isUnlocked()) return;
        const vaultToken = gitVaultToken();
        if (!vaultToken) return;
        if (!gitTokenCache[winId]) {
            if (!(await gitStoreDevice(winId, vaultToken, gitTokenGen[winId] || 0))) return;
            gitTokenCache[winId] = vaultToken;
            delete gitTokenProblem[winId];
        }
        await k.removeSecret('github-token');
        gitLog('auth', 'Moved the saved GitHub token from My Keys to this device\'s key, so it no longer needs My Keys to be unlocked', 'info');
    } catch (e) { /* the copy in My Keys stays; tried again next unlock */ }
    finally { gitMovingToken = false; }
}
// Stores a verified token. Device key first; the My Keys vault is the fallback when the device key cannot be used.
async function gitSaveToken(token) {
    const winId = gitWinId(), keys = gitKeys();
    if (gitDevice()) {
        gitBumpTokenGen(winId);
        try {
            if (await gitStoreDevice(winId, token, gitTokenGen[winId])) {
                gitTokenCache[winId] = token;
                delete gitTokenProblem[winId];
                try { localStorage.removeItem(gitTokenKey(winId)); } catch (e) { /* no plain copy to remove */ }
                // An older copy in My Keys must not outlive the token it belonged to.
                if (keys && keys.isUnlocked() && gitVaultToken()) { try { await keys.removeSecret('github-token'); } catch (e) { /* removed next unlock */ } }
                return 'device';
            }
        } catch (e) { /* fall through to My Keys */ }
    }
    if (keys && keys.isUnlocked()) {
        try { await keys.setSecret('github-token', token); }
        catch (storeErr) { throw new Error('The token is valid but could not be saved to My Keys. Make sure it is unlocked and try again.'); }
        gitBumpTokenGen(winId); delete gitTokenCache[winId]; delete gitTokenProblem[winId];
        try { localStorage.removeItem(gitEncKey(winId)); localStorage.removeItem(gitTokenKey(winId)); } catch (e) { /* nothing to remove */ }
        return 'vault';
    }
    gitRequestVaultUnlock();
    throw new Error('The token is valid, but this browser would not let CodeMini store it encrypted on this device. Unlock My Keys and try again to keep it there instead.');
}
window.addEventListener('codemini:vault-state', async () => {
    if (gitDevice()) await gitMoveVaultTokenToDevice(); else await gitMoveTokenToVault();
    if (typeof window.renderGitPanel === 'function') { try { window.renderGitPanel(); } catch (e) { /* panel not mounted */ } }
});
// Another tab saved or removed this window's token: forget what this page decrypted and read it again.
window.addEventListener('storage', (e) => {
    const w = gitWinId();
    if (e.key !== null && e.key !== gitEncKey(w)) return;
    gitBumpTokenGen(w); delete gitTokenCache[w]; delete gitTokenProblem[w]; delete gitTokenLoad[w]; delete gitTokenLoaded[w];
    gitHydrateToken(w);
});
gitHydrateToken();
function gitGetGhProfile() {
    gitMigrateLegacyToken();
    try { const raw = localStorage.getItem(gitProfileKey()); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function gitMaskToken(t) { return !t ? '' : (t.length <= 10 ? '••••••••' : `${t.slice(0, 4)}••••••••${t.slice(-4)}`); }
// Only ever put GitHub-hosted URLs into href/src attributes, whatever the API returns.
function gitSafeGithubUrl(u) { return typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : ''; }
function gitSafeAvatarUrl(u) {
    if (typeof u !== 'string' || !/^https:\/\/avatars\.githubusercontent\.com\//.test(u)) return '';
    return u + (u.includes('?') ? '&' : '?') + 's=96';
}
function gitEncodePath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }
// Accepts "owner/repo" or any github.com URL / git@ address for one, and returns
// { owner, name, full } - or null. Strict on purpose: the result is interpolated
// into API URL paths, so nothing containing "?", "#", "..", spaces etc. gets through.
function gitParseRepoRef(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    const hadPrefix = /^(?:git@github\.com:|(?:https?:\/\/)?(?:www\.)?github\.com\/)/i.test(s);
    s = s.replace(/^git@github\.com:/i, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
    const parts = s.split(/[?#]/)[0].split('/').filter(Boolean);
    if (parts.length < 2 || (!hadPrefix && parts.length !== 2)) return null;
    const owner = parts[0];
    const name = parts[1].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') return null;
    return { owner, name, full: `${owner}/${name}` };
}
function gitValidateRepoName(name) {
    if (!name) return 'Repository name is required.';
    if (/\s/.test(name)) return 'Repository names cannot contain spaces. Use "-" or "_" instead.';
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Use only letters, numbers, ".", "-" and "_".';
    if (name === '.' || name === '..') return 'That name is reserved.';
    if (/\.git$/i.test(name)) return 'Repository names cannot end with ".git".';
    if (name.length > 100) return 'Repository names must be 100 characters or fewer.';
    return null;
}
async function gitCopyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) {}
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed; top:-1000px; opacity:0;';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) { return false; }
}
function gitDownloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function gitToast(message) { if (window.showSuccessToast) window.showSuccessToast(message); }

// Sends a notification to Now Island (it shows as a toast while the island is closed). Returns false when the
// notification system is not there, so a caller can fall back to the plain toast. Never throws.
function gitNotify(n) {
    try {
        if (!window.CodeMiniNotifications) return false;
        window.CodeMiniNotifications.add(Object.assign(
            { source: 'Source Control', kind: 'git', actions: ['open-source-control'] },
            n,
            { text: gitRedact(String(n.text || '')).slice(0, 400) } // an error message must never carry a token
        ));
        return true;
    } catch (e) { return false; }
}
function gitClearNotice(id) { try { if (window.CodeMiniNotifications) window.CodeMiniNotifications.remove(id); } catch (e) {} }
// One live conflict notice per repository (workspace database).
function gitNotifyConflict(dbName, title, text, fallbackToast) {
    if (!gitNotify({ id: 'git-conflict-' + dbName, title, text })) gitToast(fallbackToast);
}

// --- Source Control log ---------------------------------------------------------
// One capped, per-database record of what Source Control did (commits, branch
// operations, stash/restore, push/pull, GitHub actions, auth). Stored next to the
// rest of that repo's state. Everything goes through gitRedact() first: the log
// can be copied or exported, so a token must never be able to end up in it - not
// via an error message, not via a URL.
function gitRedact(value) {
    let s = String(value == null ? '' : value);
    s = s.replace(/(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '[redacted-token]');
    const tok = gitGetToken();
    if (tok && tok.length >= 8) s = s.split(tok).join('[redacted-token]');
    return s;
}
function gitGetLog(dbName) {
    try {
        const arr = JSON.parse(localStorage.getItem(gitStorageKey(dbName, 'log')) || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
}
// Logging must never be the reason a git operation fails (full storage, no db
// yet, ...), so every failure in here is swallowed.
function gitLog(action, message, level, details, dbNameOverride) {
    try {
        const dbName = dbNameOverride || (typeof db !== 'undefined' && db && db.name) || '';
        if (!dbName) return;
        let entries = gitGetLog(dbName);
        const entry = { id: gitNewId('l'), ts: Date.now(), level: level || 'info', action, message: gitRedact(message).slice(0, 500) };
        if (details) {
            try { const d = gitRedact(JSON.stringify(details)); if (d.length <= 1500) entry.details = JSON.parse(d); } catch (e) {}
        }
        entries.push(entry);
        if (entries.length > GIT_LOG_MAX) entries = entries.slice(-GIT_LOG_MAX);
        localStorage.setItem(gitStorageKey(dbName, 'log'), JSON.stringify(entries));
    } catch (e) {}
}
function gitBuildLogExport(dbName) {
    const config = getGitConfig(dbName);
    const identity = gitResolveIdentity(dbName);
    const gh = gitGetGhProfile();
    const entries = gitGetLog(dbName).map(e => Object.assign({}, e, { time: new Date(e.ts).toISOString() }));
    return {
        app: 'CodeMini', type: 'source-control-log', version: 1, exportedAt: new Date().toISOString(),
        repository: {
            database: dbName, currentBranch: config.currentBranch,
            remote: { repo: localStorage.getItem(gitStorageKey(dbName, 'remoteRepo')) || null, branch: localStorage.getItem(gitStorageKey(dbName, 'remoteBranch')) || null }
        },
        identity: { name: identity.name, source: identity.source },
        github: gh ? { connected: true, login: gh.login } : { connected: false },
        count: entries.length, entries
    };
}
async function gitCopyLog() {
    const json = JSON.stringify(gitBuildLogExport(db.name), null, 2);
    gitToast((await gitCopyText(json)) ? 'Log copied as JSON' : 'Could not copy - use Export instead');
}
function gitExportLog() {
    const dbName = db.name;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
    const safeDb = String(dbName).replace(/[^A-Za-z0-9._-]+/g, '_');
    gitDownloadText(`codemini-source-control-log-${safeDb}-${stamp}.json`, JSON.stringify(gitBuildLogExport(dbName), null, 2));
    gitToast('Log exported');
}
function gitClearLog() {
    const dbName = db.name;
    const doClear = () => { localStorage.removeItem(gitStorageKey(dbName, 'log')); window.renderGitPanel(); gitToast('Log cleared'); };
    if (window.showCustomModal) window.showCustomModal({ title: 'Clear Source Control Log', text: 'This permanently deletes every log entry for this repository. Your commits and files are not affected.', submitText: 'Clear' }, doClear);
    else if (confirm('Clear the Source Control log?')) doClear();
}

// --- Local profile & commit identity ----------------------------------------------
// The app's own profile (settings-profile.js) is not stored anywhere - its page
// derives everything from the active window. This mirrors those exact rules, so the
// "Local profile" card always matches what the Profile page shows and the commit
// identity follows the profile live (rename/switch window and it follows) instead
// of being a stale copy.
function gitGetLocalProfile() {
    const w = (typeof cellActiveWindow !== 'undefined' && cellActiveWindow)
        ? cellActiveWindow
        : { id: 'win_default', name: '- Native Window -', db: (typeof db !== 'undefined' && db && db.name) || 'CodeMiniDB', profile: false };
    const isProfile = !!w.profile;
    const genId = String(w.id || '').split('_')[1] || '000';
    const username = isProfile ? `profile_user_${genId}` : 'user_local';
    // Same source as the Profile screen (this used to read the raw stored value, which is now a timestamp)
    let memberSince = '';
    try { if (typeof window.getMemberSince === 'function') memberSince = window.formatMemberSince(window.getMemberSince(w)); } catch (e) {}
    return {
        windowId: w.id, displayName: w.name || username, isProfile, username,
        email: isProfile ? `${username}@codemini.local` : 'user@codemini.local',
        database: w.db || '', memberSince
    };
}
function gitGithubNoreplyEmail(gh) { return `${gh.id}+${gh.login}@users.noreply.github.com`; }
// Who commits are attributed to: 'profile' (default, follows the app profile),
// 'github' (the connected account), or 'custom' (typed in Config).
function gitResolveIdentity(dbName) {
    const config = getGitConfig(dbName || (typeof db !== 'undefined' && db ? db.name : ''));
    const profile = gitGetLocalProfile();
    const gh = gitGetGhProfile();
    let source = config.identitySource || 'profile';
    if (source === 'github' && !gh) source = 'profile';
    if (source === 'custom') {
        const name = (config.customName || '').trim();
        if (name) return { source: 'custom', name, email: (config.customEmail || '').trim() || profile.email };
        source = 'profile';
    }
    if (source === 'github') return { source: 'github', name: gh.name || gh.login, email: gh.email || gitGithubNoreplyEmail(gh) };
    return { source: 'profile', name: profile.username, email: profile.email };
}
function gitAuthorFields(dbName) {
    const id = gitResolveIdentity(dbName);
    return { author: id.name, authorEmail: id.email };
}
function gitSetIdentitySource(source) {
    if (!['profile', 'github', 'custom'].includes(source)) return;
    const dbName = db.name;
    const config = getGitConfig(dbName);
    if (source === 'github' && !gitGetGhProfile()) { gitToast('Connect GitHub first'); window.renderGitPanel(); return; }
    if (source === 'custom' && !(config.customName || '').trim()) {
        // Start from whoever is currently the author so "Custom" is a tweak, not a blank form.
        const cur = gitResolveIdentity(dbName);
        config.customName = cur.name; config.customEmail = cur.email;
    }
    config.identitySource = source;
    saveGitConfig(dbName, config);
    const id = gitResolveIdentity(dbName);
    gitLog('identity', `Commit identity source set to "${source}" (${id.name} <${id.email}>)`, 'info', null, dbName);
    window.renderGitPanel();
}
function gitSaveCustomIdentity() {
    const ui = gitUi();
    const dbName = db.name;
    const name = gitFieldValue('gitIdentityName').trim();
    const email = gitFieldValue('gitIdentityEmail').trim();
    let problem = null;
    if (!name) problem = 'Name cannot be empty.';
    else if (name.length > 100 || /[<>\x00-\x1f]/.test(name)) problem = 'Name must be 100 characters or fewer and cannot contain < > or control characters.';
    else if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) problem = 'That email address does not look valid.';
    if (problem) { gitSetResult(ui, 'identity', 'error', problem); window.renderGitPanel(); return; }
    const config = getGitConfig(dbName);
    config.identitySource = 'custom'; config.customName = name; config.customEmail = email;
    saveGitConfig(dbName, config);
    delete ui.results.identity; delete ui.drafts.gitIdentityName; delete ui.drafts.gitIdentityEmail;
    gitLog('identity', `Custom commit identity saved (${name}${email ? ` <${email}>` : ''})`, 'success', null, dbName);
    gitToast('Identity saved');
    window.renderGitPanel();
}
function gitRepoStats(dbName) {
    const repo = getGitRepo(dbName); const config = getGitConfig(dbName);
    const tip = gitBranchExists(repo, config.currentBranch) ? repo.refs[config.currentBranch] : null;
    const chars = ['config', 'repo', 'staged', 'log'].reduce((n, k) => n + (localStorage.getItem(gitStorageKey(dbName, k)) || '').length, 0);
    return {
        branches: Object.keys(repo.refs).length,
        tags: Object.keys(repo.tags || {}).length,
        commitsOnBranch: tip ? gitWalkAncestors(repo, tip).length : 0,
        totalCommits: Object.keys(repo.objects).length,
        stashes: (repo.stash || []).length,
        staged: getStagedPaths(dbName).length,
        logEntries: gitGetLog(dbName).length,
        sizeKb: Math.max(1, Math.round(chars / 1024))
    };
}

// --- GitHub REST API ----------------------------------------------------------------
async function gitHubRequest(endpoint, options = {}) {
    const { tokenOverride, withHeaders } = options;
    const fetchOptions = Object.assign({}, options);
    delete fetchOptions.tokenOverride; delete fetchOptions.withHeaders;
    const token = tokenOverride || gitGetToken();
    if (!token) {
        const err = new Error('No GitHub token configured. Add one in the Config tab.');
        err.status = 401; err.noToken = true; throw err;
    }
    const headers = Object.assign(
        { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
        fetchOptions.body ? { 'Content-Type': 'application/json' } : {},
        fetchOptions.headers || {}
    );
    let res;
    try {
        // cache:'no-store' asks the browser HTTP cache to stay out of it. (The service
        // worker also never caches this API - see sw.js - but both layers matter: this
        // data is account state that changes underneath us.)
        res = await fetch(`https://api.github.com${endpoint}`, Object.assign({}, fetchOptions, { headers, cache: 'no-store' }));
    } catch (e) {
        const err = new Error('Could not reach GitHub - check your internet connection.');
        err.network = true; throw err;
    }
    if (!res.ok) {
        let msg = res.statusText || `HTTP ${res.status}`;
        let body = null;
        try { body = await res.json(); } catch (e) {}
        if (body && body.message) msg = body.message;
        if (body && Array.isArray(body.errors) && body.errors.length) {
            const details = body.errors.map(x => typeof x === 'string' ? x : (x.message || [x.resource, x.field, x.code].filter(Boolean).join(' '))).filter(Boolean).join('; ');
            if (details) msg += `: ${details}`;
        }
        if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
            const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
            msg = `GitHub rate limit reached${reset ? ` - resets at ${new Date(reset).toLocaleTimeString()}` : ''}.`;
        }
        const err = new Error(`GitHub API error (${res.status}): ${msg}`);
        err.status = res.status; err.apiMessage = msg;
        // The SAVED token was refused (a token being tried out from the Config form has tokenOverride and is the
        // user's own current action, so it is not announced).
        if (res.status === 401 && !tokenOverride) gitNotifyTokenRejected();
        throw err;
    }
    const data = res.status === 204 ? null : await res.json();
    return withHeaders ? { data, headers: res.headers } : data;
}
function gitNotifyTokenRejected() {
    gitNotify({
        id: 'git-token',
        title: 'GitHub rejected your token',
        text: 'GitHub says the saved token is wrong, expired or revoked, so pushing and pulling will fail. Add a new one in the Config tab of Source Control.'
    });
}
function gitFriendlyError(e) {
    if (!e) return 'Unknown error';
    if (e.status === 401 && !e.noToken) return 'GitHub rejected the token (401 Bad credentials). It may be wrong, expired or revoked - add a new one in the Config tab.';
    return e.message || String(e);
}
function gitBuildProfile(u, scopesHeader) {
    return {
        login: u.login, id: u.id, name: u.name || '', email: u.email || '', avatar_url: u.avatar_url || '',
        html_url: u.html_url || '', bio: u.bio || '', public_repos: u.public_repos, private_repos: u.owned_private_repos,
        followers: u.followers, following: u.following,
        // Classic tokens report their scopes in a header; fine-grained tokens don't send it at all.
        scopes: (scopesHeader === null || scopesHeader === undefined) ? null : String(scopesHeader).split(',').map(s => s.trim()).filter(Boolean),
        verifiedAt: Date.now()
    };
}
async function gitAuthenticate(token) {
    const { data, headers } = await gitHubRequest('/user', { tokenOverride: token, withHeaders: true });
    if (!data || !data.login) throw new Error('Unexpected response from GitHub.');
    return gitBuildProfile(data, headers.get('x-oauth-scopes'));
}
// Save & Authenticate: the token is only stored if GitHub accepts it, so a typo
// can never replace a working token.
async function gitConnectGitHub() {
    const ui = gitUi();
    if (ui.busy.auth) return;
    const token = gitFieldValue('gitTokenInput').trim();
    if (!token) { gitSetResult(ui, 'auth', 'error', 'Paste a personal access token first.'); window.renderGitPanel(); return; }
    if (/\s/.test(token)) { gitSetResult(ui, 'auth', 'error', 'A token cannot contain spaces or line breaks.'); window.renderGitPanel(); return; }
    const keys = gitKeys();
    // With the device key there is nothing to unlock. Without it the token can only be kept in the My Keys vault.
    if (!gitDevice() && (!keys || !keys.isUnlocked())) {
        gitSetResult(ui, 'auth', 'error', 'Unlock My Keys first. Your token is stored encrypted in your vault (you will be asked to create the vault if you have not yet).');
        window.renderGitPanel(); gitRequestVaultUnlock(); return;
    }
    ui.busy.auth = true; gitSetResult(ui, 'auth', 'info', 'Verifying token with GitHub...'); window.renderGitPanel();
    try {
        const profile = await gitAuthenticate(token);
        await gitSaveToken(token);
        localStorage.setItem(gitProfileKey(), JSON.stringify(profile));
        gitResetGithubCaches();
        gitClearNotice('git-token');
        delete ui.drafts.gitTokenInput; ui.sections.replaceToken = false;
        gitSetResult(ui, 'auth', 'success', `Connected as @${profile.login}.`);
        gitAutoClearResult(ui, 'auth');
        gitLog('auth', `Connected GitHub account @${profile.login}`, 'success');
        gitToast(`Connected as @${profile.login}`);
    } catch (e) {
        gitSetResult(ui, 'auth', 'error', gitFriendlyError(e));
        gitLog('auth', `GitHub authentication failed: ${e.message}`, 'error');
    } finally { ui.busy.auth = false; window.renderGitPanel(); }
}
// Re-checks the saved token (button, or automatically once for a token
// this window hasn't verified in this session yet).
async function gitVerifyGitHub(opts) {
    opts = opts || {};
    const ui = gitUi();
    const token = gitGetToken();
    if (!token || ui.busy.auth) return;
    ui.busy.auth = true;
    if (!opts.silent) gitSetResult(ui, 'auth', 'info', 'Verifying token with GitHub...');
    window.renderGitPanel();
    try {
        const profile = await gitAuthenticate(token);
        localStorage.setItem(gitProfileKey(), JSON.stringify(profile));
        gitClearNotice('git-token');
        if (!opts.silent) { gitSetResult(ui, 'auth', 'success', `Token is valid - @${profile.login}.`); gitAutoClearResult(ui, 'auth'); }
        else delete ui.results.auth;
        gitLog('auth', `Verified GitHub token for @${profile.login}`, 'info');
    } catch (e) {
        // A 401 means the saved token is dead: drop the cached profile so the UI stops
        // claiming we're connected. Any other failure (offline, rate limit) keeps it.
        if (e.status === 401) { localStorage.removeItem(gitProfileKey()); gitNotifyTokenRejected(); }
        gitSetResult(ui, 'auth', 'error', gitFriendlyError(e));
        gitLog('auth', `Token verification failed: ${e.message}`, 'error');
    } finally { ui.busy.auth = false; window.renderGitPanel(); }
}
function gitDisconnectGitHub() {
    const doDisconnect = async () => {
        const gh = gitGetGhProfile();
        const keys = gitKeys();
        if (gitTokenLocked()) { gitToast('Unlock My Keys to disconnect: the token is stored there.'); gitRequestVaultUnlock(); return; }
        if (keys && keys.isUnlocked() && gitVaultToken()) {
            try { await keys.removeSecret('github-token'); } catch (e) { gitToast('Could not remove the token from My Keys.'); return; }
        }
        const winId = gitWinId();
        gitBumpTokenGen(winId); delete gitTokenCache[winId]; delete gitTokenProblem[winId];
        localStorage.removeItem(gitEncKey(winId));
        localStorage.removeItem(gitTokenKey());
        localStorage.removeItem(gitProfileKey());
        gitResetGithubCaches();
        gitClearNotice('git-token');
        const ui = gitUi();
        ui.results = {}; ui.sections.replaceToken = false;
        gitLog('auth', `Disconnected GitHub account${gh ? ` @${gh.login}` : ''}`, 'info');
        gitToast('GitHub disconnected');
        window.renderGitPanel();
    };
    if (window.showCustomModal) window.showCustomModal({ title: 'Disconnect GitHub', text: 'This removes the saved token and profile for this window/profile only. Your local files and commits are not affected.', submitText: 'Disconnect' }, doDisconnect);
    else if (confirm('Remove the saved GitHub token?')) doDisconnect();
}
function gitAutoVerifyToken() {
    const token = gitGetToken();
    if (!token || gitGetGhProfile()) return;
    const gh = gitGHState();
    if (gh.autoVerifyTried === token) return;
    gh.autoVerifyTried = token;
    gitVerifyGitHub({ silent: true });
}

// --- Repositories ---------------------------------------------------------------------
function gitSlimRepo(r) {
    return {
        id: r.id, name: r.name, full_name: r.full_name, private: !!r.private, fork: !!r.fork, archived: !!r.archived,
        description: r.description || '', html_url: r.html_url || '', default_branch: r.default_branch || 'main',
        stars: r.stargazers_count || 0, updated: r.pushed_at || r.updated_at || ''
    };
}
async function gitLoadRepos(reset) {
    const gh = gitGHState(); const r = gh.repos;
    if (r.loading || !gitGetToken()) return;
    if (reset) { r.items = []; r.page = 0; r.hasMore = false; r.loaded = false; }
    r.loading = true; r.error = null;
    window.renderGitPanel();
    const token = gitGetToken();
    const dbName = db.name;
    try {
        const page = r.page + 1;
        // `type=owner` and `affiliation` are mutually exclusive in the API; leaving
        // both off returns everything the account can see (owner + collaborator + org).
        const filter = r.scope === 'owner' ? '&type=owner' : '';
        const data = await gitHubRequest(`/user/repos?per_page=100&page=${page}&sort=updated&direction=desc${filter}`);
        if (gitGetToken() !== token) return; // the account changed while this was in flight - discard
        r.items = r.items.concat(data.map(gitSlimRepo));
        r.page = page; r.hasMore = data.length === 100; r.loaded = true;
    } catch (e) {
        r.error = gitFriendlyError(e);
        gitLog('repos', `Could not load repositories: ${e.message}`, 'error', null, dbName);
    } finally { r.loading = false; window.renderGitPanel(); }
}
async function gitLoadBranches(full, force) {
    const gh = gitGHState();
    if (!full || !gitGetToken()) return;
    if (gh.branchesTried[full] && !force) return;
    gh.branchesTried[full] = true;
    try {
        const data = await gitHubRequest(`/repos/${full}/branches?per_page=100`);
        gh.branches[full] = data.map(b => b.name);
    } catch (e) { gh.branches[full] = []; }
    window.renderGitPanel();
}


// --- Remote tracking ---------------------------------------------------------
// Real git keeps a local, offline copy of "where the remote branch was as of
// the last time we looked" (refs/remotes/origin/main) so ahead/behind and a
// safe pull can be computed WITHOUT hitting the network every time, and so
// pull can tell "the remote moved since I last checked" apart from "the
// remote has always been here." This app has no such local copy of remote
// state at all today - push and pull each separately hit the network with
// no memory of the last sync, so there is no way to warn before a pull
// silently overwrites work that only exists on the remote (Tier 1 gap #7).
//
// One record per dbName+branch (a repo can track different remote branches
// depending on what's configured in the Remote tab): { branchSha, message,
// fetchedAt }. branchSha is the tip of refs/heads/<branch> on the remote as
// of the last fetch/push/pull - NOT a claim that this app made one atomic
// commit there (push here still writes one GitHub commit per file, see
// Tier 4 gap #21 elsewhere on this list; branchSha is simply whatever the
// branch ref pointed to right after the last push finished, fetched fresh
// via one extra request rather than assumed from the last file's own commit
// sha, which would be wrong if the push loop had failed partway through).
function gitRemoteTrackingKey(dbName, branch) { return gitStorageKey(dbName, `remotetrack_${branch}`); }
function gitGetRemoteTracking(dbName, branch) {
    try {
        const raw = localStorage.getItem(gitRemoteTrackingKey(dbName, branch));
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
}
function gitSaveRemoteTracking(dbName, branch, tracking) {
    localStorage.setItem(gitRemoteTrackingKey(dbName, branch), JSON.stringify(tracking));
}
// Looks up the remote branch's current tip sha and message with a single
// request (real git's `fetch`, minus downloading any actual content) and
// records it as this app's own refs/remotes/origin/<branch> equivalent.
// Never touches the working tree or local commits - that's what pull is
// for. Returns the tracking record, or null on failure (network error,
// branch/repo doesn't exist, no token) - callers treat null as "couldn't
// check" rather than "confirmed no remote branch."
async function gitFetchRemoteTracking(ref, branch, dbName) {
    try {
        const refData = await gitHubRequest(`/repos/${ref.full}/git/refs/heads/${gitEncodePath(branch)}`);
        const sha = refData.object.sha;
        let message = '';
        try { const commitData = await gitHubRequest(`/repos/${ref.full}/git/commits/${sha}`); message = commitData.message || ''; } catch (e) {}
        const tracking = { branchSha: sha, message, fetchedAt: Date.now() };
        gitSaveRemoteTracking(dbName, branch, tracking);
        return tracking;
    } catch (e) {
        return null;
    }
}
// How many commits the remote branch is ahead of `sinceSha` (typically the
// last-known remote sha, or a local sha believed to be a shared ancestor),
// walking the REMOTE's own parent chain via the GitHub Git Data API
// (parents are a real field on a commit object there) rather than assuming
// anything about local history. Capped at maxDepth requests - this walks
// one network round-trip per commit, so an unbounded walk on a
// long-diverged repo would be slow and wasteful for a number the UI only
// ever needs approximately. Returns { count, capped, foundSince } - capped
// is true if the walk hit the limit before finding sinceSha (displayed as
// "50+" rather than a false-precision exact number), foundSince is false if
// sinceSha was never reached at all (fully unrelated history, or sinceSha
// no longer exists upstream after a force-push/rebase on the remote).
async function gitCountRemoteAhead(ref, tipSha, sinceSha, maxDepth) {
    maxDepth = maxDepth || 50;
    if (!tipSha || tipSha === sinceSha) return { count: 0, capped: false, foundSince: true };
    let count = 0;
    let cursor = tipSha;
    const seen = new Set();
    while (cursor && count < maxDepth) {
        if (seen.has(cursor)) break; // defensive: a real DAG can't cycle, but never spin forever on bad data
        seen.add(cursor);
        if (cursor === sinceSha) return { count, capped: false, foundSince: true };
        count++;
        try {
            const commitData = await gitHubRequest(`/repos/${ref.full}/git/commits/${cursor}`);
            cursor = (commitData.parents && commitData.parents[0] && commitData.parents[0].sha) || null;
        } catch (e) {
            return { count, capped: false, foundSince: false }; // network hiccup mid-walk - report what we have rather than nothing
        }
    }
    return { count, capped: count >= maxDepth, foundSince: cursor === sinceSha };
}
function gitSetRemote(dbName, full, branch, ui) {
    localStorage.setItem(gitStorageKey(dbName, 'remoteRepo'), full);
    if (branch) localStorage.setItem(gitStorageKey(dbName, 'remoteBranch'), branch);
    if (ui) { ui.drafts.gitRepoInput = full; if (branch) ui.drafts.gitRemoteBranchInput = branch; }
}
function gitUseRepo(full, branch) {
    const ref = gitParseRepoRef(full);
    if (!ref) return;
    gitSetRemote(db.name, ref.full, branch || 'main', gitUi());
    gitLog('remote', `Remote set to ${ref.full}@${branch || 'main'}`, 'info');
    gitToast(`Remote set to ${ref.full}`);
    window.renderGitPanel();
}
function gitAutoLoadRemoteData(ui) {
    if (!gitGetToken()) return;
    const gh = gitGHState();
    if (gitSectionOpen(ui, 'repos') && !gh.repos.loaded && !gh.repos.loading && !gh.repos.error) gitLoadRepos(false);
    const ref = gitParseRepoRef(gitDraft(ui, 'gitRepoInput', localStorage.getItem(gitStorageKey(db.name, 'remoteRepo')) || ''));
    if (ref && !gh.branchesTried[ref.full]) gitLoadBranches(ref.full);
}

// --- New repository / fork / issue / pull request ----------------------------------
async function gitCreateRepo() {
    const ui = gitUi();
    if (ui.busy.createRepo) return;
    const name = gitFieldValue('gitNewRepoName').trim();
    const description = gitFieldValue('gitNewRepoDesc').trim();
    const isPrivate = gitFieldChecked('gitNewRepoPrivate', true);
    const readme = gitFieldChecked('gitNewRepoReadme', true);
    const problem = gitValidateRepoName(name);
    if (problem) { gitSetResult(ui, 'newRepo', 'error', problem); window.renderGitPanel(); return; }
    const dbName = db.name;
    ui.busy.createRepo = true; gitSetResult(ui, 'newRepo', 'info', `Creating ${name}...`); window.renderGitPanel();
    try {
        const data = await gitHubRequest('/user/repos', { method: 'POST', body: JSON.stringify({ name, description: description || undefined, private: isPrivate, auto_init: readme }) });
        const slim = gitSlimRepo(data);
        const gh = gitGHState();
        if (gh.repos.loaded) gh.repos.items = [slim].concat(gh.repos.items.filter(x => x.full_name !== slim.full_name));
        gitSetRemote(dbName, slim.full_name, slim.default_branch, ui);
        delete ui.drafts.gitNewRepoName; delete ui.drafts.gitNewRepoDesc;
        gitSetResult(ui, 'newRepo', 'success', `Created ${slim.full_name} and set it as this workspace's remote.`, { url: slim.html_url });
        gitLog('repo-create', `Created ${slim.private ? 'private' : 'public'} repository ${slim.full_name}`, 'success', { repo: slim.full_name }, dbName);
        gitToast(`Created ${slim.full_name}`);
    } catch (e) {
        gitSetResult(ui, 'newRepo', 'error', gitFriendlyError(e));
        gitLog('repo-create', `Failed to create repository "${name}": ${e.message}`, 'error', null, dbName);
    } finally { ui.busy.createRepo = false; window.renderGitPanel(); }
}
async function gitForkRepo() {
    const ui = gitUi();
    if (ui.busy.fork) return;
    const ref = gitParseRepoRef(gitFieldValue('gitForkRepoInput'));
    const gh = gitGetGhProfile();
    if (!ref) { gitSetResult(ui, 'fork', 'error', 'Enter a repository as owner/repo (or paste its GitHub URL).'); window.renderGitPanel(); return; }
    if (gh && gh.login.toLowerCase() === ref.owner.toLowerCase()) { gitSetResult(ui, 'fork', 'error', "You can't fork your own repository."); window.renderGitPanel(); return; }
    const dbName = db.name;
    ui.busy.fork = true; gitSetResult(ui, 'fork', 'info', `Forking ${ref.full}...`); window.renderGitPanel();
    try {
        const data = await gitHubRequest(`/repos/${ref.full}/forks`, { method: 'POST', body: JSON.stringify({}) });
        const slim = gitSlimRepo(data);
        const state = gitGHState();
        if (state.repos.loaded) state.repos.items = [slim].concat(state.repos.items.filter(x => x.full_name !== slim.full_name));
        gitSetResult(ui, 'fork', 'success', `Forked to ${slim.full_name}. GitHub can take a few seconds to finish copying the files.`, { url: slim.html_url, useRepo: slim.full_name, useBranch: slim.default_branch });
        gitLog('fork', `Forked ${ref.full} to ${slim.full_name}`, 'success', { source: ref.full, fork: slim.full_name }, dbName);
        gitToast(`Forked ${ref.full}`);
    } catch (e) {
        gitSetResult(ui, 'fork', 'error', gitFriendlyError(e));
        gitLog('fork', `Failed to fork ${ref.full}: ${e.message}`, 'error', null, dbName);
    } finally { ui.busy.fork = false; window.renderGitPanel(); }
}
async function gitCreateIssue() {
    const ui = gitUi();
    if (ui.busy.issue) return;
    const ref = gitParseRepoRef(gitFieldValue('gitIssueRepo'));
    const title = gitFieldValue('gitIssueTitle').trim();
    const body = gitFieldValue('gitIssueBody').trim();
    const labels = gitFieldValue('gitIssueLabels').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
    let problem = null;
    if (!ref) problem = 'Enter the repository as owner/repo.';
    else if (!title) problem = 'An issue needs a title.';
    else if (title.length > 256) problem = 'Titles must be 256 characters or fewer.';
    if (problem) { gitSetResult(ui, 'issue', 'error', problem); window.renderGitPanel(); return; }
    const dbName = db.name;
    ui.busy.issue = true; gitSetResult(ui, 'issue', 'info', 'Creating issue...'); window.renderGitPanel();
    try {
        const payload = { title }; if (body) payload.body = body; if (labels.length) payload.labels = labels;
        const data = await gitHubRequest(`/repos/${ref.full}/issues`, { method: 'POST', body: JSON.stringify(payload) });
        delete ui.drafts.gitIssueTitle; delete ui.drafts.gitIssueBody; delete ui.drafts.gitIssueLabels;
        gitSetResult(ui, 'issue', 'success', `Created issue #${data.number} in ${ref.full}.`, { url: data.html_url, linkText: `Open #${data.number}` });
        gitLog('issue-create', `Created issue #${data.number} "${title}" in ${ref.full}`, 'success', { repo: ref.full, number: data.number }, dbName);
        gitToast(`Issue #${data.number} created`);
    } catch (e) {
        gitSetResult(ui, 'issue', 'error', gitFriendlyError(e));
        gitLog('issue-create', `Failed to create issue in ${ref.full}: ${e.message}`, 'error', null, dbName);
    } finally { ui.busy.issue = false; window.renderGitPanel(); }
}
async function gitCreatePullRequest() {
    const ui = gitUi();
    if (ui.busy.pr) return;
    const ref = gitParseRepoRef(gitFieldValue('gitPrRepo'));
    const title = gitFieldValue('gitPrTitle').trim();
    const head = gitFieldValue('gitPrHead').trim();
    const base = gitFieldValue('gitPrBase').trim();
    const body = gitFieldValue('gitPrBody').trim();
    const draft = gitFieldChecked('gitPrDraft', false);
    let problem = null;
    if (!ref) problem = 'Enter the repository as owner/repo.';
    else if (!title) problem = 'A pull request needs a title.';
    else if (!head) problem = 'Enter the head branch (the branch with your changes).';
    else if (!base) problem = 'Enter the base branch (the branch to merge into).';
    else if (head === base) problem = 'Head and base must be different branches.';
    if (problem) { gitSetResult(ui, 'pr', 'error', problem); window.renderGitPanel(); return; }
    const dbName = db.name;
    ui.busy.pr = true; gitSetResult(ui, 'pr', 'info', 'Creating pull request...'); window.renderGitPanel();
    try {
        const payload = { title, head, base, draft, maintainer_can_modify: true }; if (body) payload.body = body;
        const data = await gitHubRequest(`/repos/${ref.full}/pulls`, { method: 'POST', body: JSON.stringify(payload) });
        delete ui.drafts.gitPrTitle; delete ui.drafts.gitPrBody;
        gitSetResult(ui, 'pr', 'success', `Created ${draft ? 'draft ' : ''}pull request #${data.number} (${head} into ${base}).`, { url: data.html_url, linkText: `Open #${data.number}` });
        gitLog('pr-create', `Created pull request #${data.number} "${title}" in ${ref.full} (${head} -> ${base})`, 'success', { repo: ref.full, number: data.number, head, base, draft }, dbName);
        gitToast(`Pull request #${data.number} created`);
    } catch (e) {
        gitSetResult(ui, 'pr', 'error', gitFriendlyError(e));
        gitLog('pr-create', `Failed to create pull request in ${ref.full}: ${e.message}`, 'error', null, dbName);
    } finally { ui.busy.pr = false; window.renderGitPanel(); }
}

// --- Push / Pull -------------------------------------------------------------------------
// Progress is written to whichever #gitRemoteStatus is on screen *right now* (looked
// up fresh each time) and mirrored into ui.results, so a re-render mid-push - a file
// list reload, a repo list finishing - can't leave the status pointing at a dead node.
function gitSetRemoteProgress(ui, text) {
    gitSetResult(ui, 'remote', 'info', text);
    const el = document.querySelector('#gitRemoteStatus .git-result-text');
    if (el) el.textContent = text;
}
function gitReadRemoteFields(ui) {
    const ref = gitParseRepoRef(gitFieldValue('gitRepoInput'));
    const branch = (gitFieldValue('gitRemoteBranchInput') || 'main').trim() || 'main';
    if (!ref) { gitSetResult(ui, 'remote', 'error', 'Enter a repository as owner/repo (or paste its GitHub URL) first.'); window.renderGitPanel(); return null; }
    const bad = gitValidateBranchName(branch);
    if (bad) { gitSetResult(ui, 'remote', 'error', `Branch: ${bad}`); window.renderGitPanel(); return null; }
    return { ref, branch };
}
async function gitPushToGitHub() {
    const ui = gitUi();
    if (ui.busy.sync) return;
    if (!gitGetToken()) { gitSetResult(ui, 'remote', 'error', gitNoTokenMessage()); window.renderGitPanel(); return; }
    const fields = gitReadRemoteFields(ui); if (!fields) return;
    const { ref, branch } = fields;
    const database = db; const dbName = database.name;
    gitSetRemote(dbName, ref.full, branch, ui);

    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const tree = gitComputeHeadTree(repo, config.currentBranch);
    if (tree.size === 0) { gitSetResult(ui, 'remote', 'error', 'Nothing committed yet to push.'); window.renderGitPanel(); return; }

    // Only a *custom* identity is sent as author/committer. Otherwise GitHub attributes
    // the commits to the authenticated account, which is what makes them show up on
    // that account's profile - an @codemini.local address can't do that.
    const identity = gitResolveIdentity(dbName);
    const who = identity.source === 'custom' ? { author: { name: identity.name, email: identity.email }, committer: { name: identity.name, email: identity.email } } : {};

    ui.busy.sync = true;
    let done = 0;
    try {
        for (const [path, data] of tree.entries()) {
            done++;
            gitSetRemoteProgress(ui, `Pushing ${done}/${tree.size}: ${path}`);
            const ghPath = gitEncodePath(path.replace(/^\//, ''));
            let sha;
            try { const existing = await gitHubRequest(`/repos/${ref.full}/contents/${ghPath}?ref=${encodeURIComponent(branch)}`); sha = existing.sha; }
            catch (e) { sha = undefined; }
            const content = data.encoding === 'base64' ? data.content : btoa(unescape(encodeURIComponent(data.content)));
            await gitHubRequest(`/repos/${ref.full}/contents/${ghPath}`, {
                method: 'PUT',
                body: JSON.stringify(Object.assign({ message: `Update ${path} via CodeMini`, content, branch, sha }, who))
            });
        }
        gitSetResult(ui, 'remote', 'success', `Pushed ${tree.size} file(s) to ${ref.full}@${branch}.`, { url: `https://github.com/${ref.full}/tree/${gitEncodePath(branch)}`, linkText: 'View on GitHub' });
        gitAutoClearResult(ui, 'remote');
        gitLog('push', `Pushed ${tree.size} file(s) from "${config.currentBranch}" to ${ref.full}@${branch}`, 'success', { repo: ref.full, branch, files: tree.size }, dbName);
        gitToast('Pushed to GitHub');
        gitClearNotice('git-push-failed');
        gitFetchRemoteTracking(ref, branch, dbName).then(() => window.gitUpdateStatusBranch());
    } catch (e) {
        gitSetResult(ui, 'remote', 'error', `${gitFriendlyError(e)}${done > 1 ? ` (${done - 1} of ${tree.size} file(s) had already been pushed.)` : ''}`);
        gitLog('push', `Push to ${ref.full}@${branch} failed on file ${done}/${tree.size}: ${e.message}`, 'error', { repo: ref.full, branch }, dbName);
        // A rejected token already has its own notification (from gitHubRequest), so this one is for everything else.
        if (!(e.status === 401 && !e.noToken)) {
            gitNotify({
                id: 'git-push-failed',
                title: 'Push to GitHub failed',
                text: `${ref.full}@${branch}: ${gitFriendlyError(e)}${done > 1 ? ` (${done - 1} of ${tree.size} file(s) had already been pushed.)` : ''}`
            });
        }
    } finally { ui.busy.sync = false; window.renderGitPanel(); }
}
// User-facing "Fetch": checks the remote branch's current state and updates
// the local remote-tracking record, without touching any working files or
// local commits - real git's actual fetch/pull distinction, which this app
// otherwise conflates (its "pull" always both checks AND applies).
async function gitFetchOnly() {
    const ui = gitUi();
    if (ui.busy.sync) return;
    if (!gitGetToken()) { gitSetResult(ui, 'remote', 'error', gitNoTokenMessage()); window.renderGitPanel(); return; }
    const fields = gitReadRemoteFields(ui); if (!fields) return;
    const { ref, branch } = fields;
    const dbName = db.name;
    ui.busy.sync = true;
    gitSetResult(ui, 'remote', 'info', `Checking ${ref.full}@${branch}...`);
    window.renderGitPanel();
    try {
        const tracking = await gitFetchRemoteTracking(ref, branch, dbName);
        if (!tracking) throw new Error('Could not reach that repository/branch.');
        const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
        const localTip = repo.refs[config.currentBranch] || null;
        const localAhead = localTip ? gitCountAhead(repo, localTip, tracking.branchSha) : 0;
        gitSetResult(ui, 'remote', 'success', `Fetched ${ref.full}@${branch}.${localAhead > 0 ? ` You have ${localAhead} local commit${localAhead === 1 ? '' : 's'} not on the remote.` : ' Up to date.'}`);
        gitAutoClearResult(ui, 'remote');
        gitLog('fetch', `Fetched ${ref.full}@${branch}`, 'info', { repo: ref.full, branch }, dbName);
    } catch (e) {
        gitSetResult(ui, 'remote', 'error', gitFriendlyError(e));
        gitLog('fetch', `Fetch from ${ref.full}@${branch} failed: ${e.message}`, 'error', { repo: ref.full, branch }, dbName);
    } finally { ui.busy.sync = false; window.renderGitPanel(); }
}
async function gitPullFromGitHub() {
    const ui = gitUi();
    if (ui.busy.sync) return;
    if (!gitGetToken()) { gitSetResult(ui, 'remote', 'error', gitNoTokenMessage()); window.renderGitPanel(); return; }
    if (gitGetPendingMerge(db.name)) { gitSetResult(ui, 'remote', 'error', 'Finish or abort the in-progress merge before pulling.'); window.renderGitPanel(); return; }
    if (gitGetPendingRebase(db.name)) { gitSetResult(ui, 'remote', 'error', 'Finish or abort the in-progress rebase before pulling.'); window.renderGitPanel(); return; }
    const fields = gitReadRemoteFields(ui); if (!fields) return;
    const { ref, branch } = fields;
    const database = db; const dbName = database.name;
    const branchPath = gitEncodePath(branch);

    const doPull = async () => {
        if (ui.busy.sync) return;
        ui.busy.sync = true;
        try {
            gitSetRemoteProgress(ui, 'Fetching repository tree...');
            const refData = await gitHubRequest(`/repos/${ref.full}/git/refs/heads/${branchPath}`);
            const commitData = await gitHubRequest(`/repos/${ref.full}/git/commits/${refData.object.sha}`);
            const treeData = await gitHubRequest(`/repos/${ref.full}/git/trees/${commitData.tree.sha}?recursive=1`);
            const blobs = treeData.tree.filter(t => t.type === 'blob');

            const targetTree = new Map();
            let done = 0;
            for (const item of blobs) {
                done++;
                gitSetRemoteProgress(ui, `Fetching ${done}/${blobs.length}: ${item.path}`);
                const blob = await gitHubRequest(`/repos/${ref.full}/git/blobs/${item.sha}`);
                // Uses the same extension list the rest of the app (up-down.js, editor.js,
                // archive.js) already treats as binary, instead of a separate hardcoded
                // regex - the two previously disagreed (this regex was missing bmp, mov,
                // webm, ogv, m4v, ogg, m4a, flac, rar, 7z, tar, gz, mkv, avi, otf, doc,
                // docx), so pulling any of those file types decoded them as UTF-8 text
                // and silently corrupted the bytes with no error shown anywhere.
                const pulledExt = item.path.split('.').pop().toLowerCase();
                const isBinary = (window.BINARY_FILE_EXTS || []).includes(pulledExt);
                const raw = (blob.content || '').replace(/\n/g, '');
                const content = isBinary ? raw : decodeURIComponent(escape(atob(raw)));
                targetTree.set('/' + item.path, { content, encoding: isBinary ? 'base64' : 'text', name: item.path.split('/').pop() });
            }

            await gitApplyTree(database, targetTree);

            const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
            if (!gitBranchExists(repo, config.currentBranch)) repo.refs[config.currentBranch] = null;
            const headTree = gitComputeHeadTree(repo, config.currentBranch);
            const pulledChanges = gitComputeChanges(targetTree, headTree);
            if (pulledChanges.length > 0) {
                const files = pulledChanges.map(c => ({ path: c.path, name: c.name, status: c.status, content: c.content, encoding: c.encoding }));
                const parentSha = repo.refs[config.currentBranch];
                const sha = await gitCreateCommitObject(repo, `Pull from ${ref.full}@${branch}`, [parentSha], files, gitAuthorFields(dbName));
                gitMoveRef(dbName, repo, config.currentBranch, sha, `Pull from ${ref.full}@${branch}`);
                saveGitRepo(dbName, repo);
            }
            gitSetRemote(dbName, ref.full, branch, ui);
            gitSaveRemoteTracking(dbName, branch, { branchSha: refData.object.sha, message: commitData.message || '', fetchedAt: Date.now() });
            saveStagedPaths(dbName, []);
            if (typeof loadFilesFromDB === 'function') loadFilesFromDB();
            gitSetResult(ui, 'remote', 'success', `Pulled ${blobs.length} file(s) from ${ref.full}@${branch}.`, { url: `https://github.com/${ref.full}/tree/${branchPath}`, linkText: 'View on GitHub' });
            gitAutoClearResult(ui, 'remote');
            gitLog('pull', `Pulled ${blobs.length} file(s) from ${ref.full}@${branch} (${pulledChanges.length} changed)`, 'success', { repo: ref.full, branch, files: blobs.length, changed: pulledChanges.length }, dbName);
            gitToast('Pulled from GitHub');
            gitClearNotice('git-pull-failed');
            window.gitUpdateStatusBranch();
        } catch (e) {
            gitSetResult(ui, 'remote', 'error', gitFriendlyError(e));
            gitLog('pull', `Pull from ${ref.full}@${branch} failed: ${e.message}`, 'error', { repo: ref.full, branch }, dbName);
            if (!(e.status === 401 && !e.noToken)) {
                gitNotify({ id: 'git-pull-failed', title: 'Pull from GitHub failed', text: `${ref.full}@${branch}: ${gitFriendlyError(e)}` });
            }
        } finally { ui.busy.sync = false; window.renderGitPanel(); }
    };

    const doCheckAndPull = async () => {
        // A quick, best-effort look at whether this pull could actually lose
        // local-only work, so the warning reflects the real situation
        // instead of the same generic notice every time. Never blocks the
        // pull itself on this check failing (offline, rate limit) - it's an
        // informational upgrade to the confirmation, not a requirement.
        const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
        const localTip = repo.refs[config.currentBranch] || null;
        const tracking = gitGetRemoteTracking(dbName, branch);
        let warningText = `This may overwrite local files that share a path with "${gitEsc(ref.full)}"@${gitEsc(branch)}. Continue?`;
        if (tracking && localTip) {
            const localAheadOfLastSync = gitCountAhead(repo, localTip, tracking.branchSha);
            if (localAheadOfLastSync > 0) {
                // Local has moved since the last known sync point - check
                // whether the remote has ALSO moved since then. If it
                // hasn't, this pull can't lose anything (nothing new to
                // pull in). If it has, this is real divergence: this app's
                // pull does not merge histories, so those local-only
                // commits' changes would not be incorporated into what
                // ends up in the working tree.
                const liveTracking = await gitFetchRemoteTracking(ref, branch, dbName);
                if (liveTracking && liveTracking.branchSha !== tracking.branchSha) {
                    warningText = `Your local branch has ${localAheadOfLastSync} commit${localAheadOfLastSync === 1 ? '' : 's'} not on the remote, AND the remote has changed since you last synced. Pulling will make your files match the remote - it will NOT merge in your local commits' changes, though the commits themselves stay in your history. Continue?`;
                }
            }
        }
        if (window.showCustomModal) {
            window.showCustomModal({ title: 'Pull from GitHub', text: warningText, submitText: 'Pull' }, doPull);
        } else if (confirm(warningText)) doPull();
    };
    doCheckAndPull();
}

// --- Rendering --------------------------------------------------------------
function gitFileRow(change, staged) {
    const meta = getFileIconAndColor(change.name, false);
    const dirPath = change.path.slice(0, change.path.length - change.name.length - 1) || '/';
    return `
        <div class="git-file-row" data-git-action="diff" data-path="${gitEsc(change.path)}">
            <i class="${meta.icon}" style="color:${meta.color}; font-size:14px; width:16px; text-align:center; flex-shrink:0;"></i>
            <span class="git-file-name" title="${gitEsc(change.name)}">${gitEsc(change.name)}</span>
            <span class="git-file-path" title="${gitEsc(change.path)}">${gitEsc(dirPath)}</span>
            <div class="git-file-actions">
                <i class="ri-arrow-go-back-line git-action-icon" title="Discard Changes" data-git-action="discard" data-path="${gitEsc(change.path)}"></i>
                ${staged
                    ? `<i class="ri-subtract-line git-action-icon" title="Unstage Changes" data-git-action="unstage" data-path="${gitEsc(change.path)}"></i>`
                    : `<i class="ri-add-line git-action-icon" title="Stage Changes" data-git-action="stage" data-path="${gitEsc(change.path)}"></i>`}
            </div>
            ${gitStatusBadge(change.status)}
        </div>
    `;
}
function renderGitHeader() {
    return `
        <div class="git-header">
            <div class="git-header-title">Source Control</div>
            <div class="git-header-icons">
                <i class="ri-refresh-line git-action-icon" title="Refresh" data-git-action="refresh"></i>
                <i class="ri-close-line git-action-icon" title="Close Source Control" data-git-action="close"></i>
            </div>
        </div>
    `;
}
function renderGitTabs(activeTab) {
    const tabs = [['changes', 'Changes'], ['history', 'History'], ['remote', 'Remote'], ['config', 'Config']];
    return `<div class="git-tabs">${tabs.map(([id, label]) => `<div class="git-tab ${activeTab === id ? 'active' : ''}" data-git-action="switch-tab" data-tab="${id}">${label}</div>`).join('')}</div>`;
}
function gitConflictRow(path, pendingMerge) {
    const name = path.split('/').pop();
    const meta = getFileIconAndColor(name, false);
    const dirPath = path.slice(0, path.length - name.length - 1) || '/';
    const theirsLabel = pendingMerge.kind === 'rebase' ? `commit ${gitShortSha(pendingMerge.sourceSha)}` : pendingMerge.sourceBranch;
    return `
        <div class="git-file-row git-conflict-row" data-git-action="conflict-diff" data-path="${gitEsc(path)}">
            <i class="ri-error-warning-fill" style="color:var(--color-danger); font-size:14px; width:16px; text-align:center; flex-shrink:0;" title="Unresolved conflict"></i>
            <span class="git-file-name" title="${gitEsc(name)}">${gitEsc(name)}</span>
            <span class="git-file-path" title="${gitEsc(path)}">${gitEsc(dirPath)}</span>
            <div class="git-file-actions">
                <span class="git-conflict-action" title="Keep ${gitEsc(pendingMerge.targetBranch)}'s version" data-git-action="resolve-conflict" data-path="${gitEsc(path)}" data-choice="mine">Mine</span>
                <span class="git-conflict-action" title="Keep ${gitEsc(theirsLabel)}'s version" data-git-action="resolve-conflict" data-path="${gitEsc(path)}" data-choice="theirs">Theirs</span>
                <span class="git-conflict-action" title="Keep both, one after the other" data-git-action="resolve-conflict" data-path="${gitEsc(path)}" data-choice="both">Both</span>
            </div>
        </div>
    `;
}
function renderChangesTab(stagedChanges, unstagedChanges, draftMsg, pendingMerge, unresolvedConflicts, uiState, hasTipCommit, ignoredPaths, hasGitignore) {
    const inMerge = !!pendingMerge;
    const isRebase = inMerge && pendingMerge.kind === 'rebase';
    const hasUnresolved = unresolvedConflicts && unresolvedConflicts.length > 0;
    const amendMode = !inMerge && hasTipCommit && !!(uiState && uiState.drafts.gitAmendMode);
    // While a merge is pending: committing is blocked until every conflict is
    // resolved, and once they are, the button finishes the merge as a real
    // two-parent commit instead of an ordinary one (see gitDoCommit). Amend
    // mode is unavailable during a pending merge - amending replaces HEAD,
    // and mid-merge "what happens when you commit next" is already spoken
    // for by finishing or aborting the merge. A rebase never uses the typed
    // message at all (each replayed commit keeps its own original message),
    // so its box, prefixes and amend toggle are hidden entirely rather than
    // shown but ignored.
    const commitDisabled = inMerge ? hasUnresolved : (amendMode ? !hasTipCommit : stagedChanges.length === 0);
    const commitLabel = isRebase
        ? (hasUnresolved ? `Resolve ${unresolvedConflicts.length} Conflict${unresolvedConflicts.length === 1 ? '' : 's'}` : 'Continue Rebase')
        : inMerge
        ? (hasUnresolved ? `Resolve ${unresolvedConflicts.length} Conflict${unresolvedConflicts.length === 1 ? '' : 's'}` : 'Commit Merge')
        : amendMode ? `Amend${stagedChanges.length ? ` + ${stagedChanges.length} Staged` : ''}`
        : `Commit${stagedChanges.length ? ` (${stagedChanges.length})` : ''}`;
    return `
        ${inMerge ? `
        <div class="git-merge-banner ${hasUnresolved ? 'has-conflicts' : 'ready'}">
            <i class="${hasUnresolved ? 'ri-error-warning-line' : 'ri-checkbox-circle-line'}"></i>
            <span>${isRebase
                ? (hasUnresolved
                    ? `Rebasing <strong>${gitEsc(pendingMerge.targetBranch)}</strong> onto <strong>${gitEsc((pendingMerge.sourceBranch.split(' onto ')[1]) || '')}</strong> - ${pendingMerge.progress}, ${unresolvedConflicts.length} conflict${unresolvedConflicts.length === 1 ? '' : 's'} left`
                    : `All conflicts resolved - continue to replay the rest of the rebase (${pendingMerge.progress})`)
                : (hasUnresolved
                    ? `Merging <strong>${gitEsc(pendingMerge.sourceBranch)}</strong> into <strong>${gitEsc(pendingMerge.targetBranch)}</strong> - ${unresolvedConflicts.length} conflict${unresolvedConflicts.length === 1 ? '' : 's'} left to resolve`
                    : `All conflicts resolved - commit to finish merging <strong>${gitEsc(pendingMerge.sourceBranch)}</strong> into <strong>${gitEsc(pendingMerge.targetBranch)}</strong>`)}</span>
            <span class="git-merge-abort" data-git-action="abort-merge">Abort</span>
        </div>` : ''}
        ${isRebase ? `
        <div class="git-commit-box">
            <button class="git-btn git-commit-btn" data-git-action="commit" ${commitDisabled ? 'disabled' : ''}>
                <i class="ri-play-line"></i> ${commitLabel}
            </button>
        </div>` : `
        <div class="git-commit-box">
            <textarea id="gitCommitMsg" class="git-commit-input" placeholder="${amendMode ? 'Amended message (leave as-is to keep the original)' : 'Message (Ctrl+Enter to commit)'}">${gitEsc(draftMsg)}</textarea>
            <div class="git-commit-prefixes">
                ${['feat:', 'fix:', 'docs:', 'style:', 'refactor:'].map(p => `<span class="git-prefix-chip" data-git-action="prefix" data-prefix="${p}">${p}</span>`).join('')}
            </div>
            ${!inMerge && hasTipCommit ? `
            <label class="git-amend-toggle">
                <input type="checkbox" id="gitAmendMode" data-git-keep ${amendMode ? 'checked' : ''} data-git-change-action="toggle-amend">
                Amend previous commit
            </label>` : ''}
            <button class="git-btn git-commit-btn" data-git-action="commit" ${commitDisabled ? 'disabled' : ''}>
                <i class="${amendMode ? 'ri-edit-2-line' : 'ri-git-commit-line'}"></i> ${commitLabel}
            </button>
        </div>`}
        ${inMerge ? `
        <div class="git-section-header"><span>MERGE CONFLICTS <span class="git-count-badge">${unresolvedConflicts.length}</span></span></div>
        <div class="git-file-list">${unresolvedConflicts.length ? unresolvedConflicts.map(p => gitConflictRow(p, pendingMerge)).join('') : `<div class="git-empty-hint">All conflicts resolved</div>`}</div>
        ` : ''}
        <div class="git-section-header">
            <span>STAGED CHANGES <span class="git-count-badge">${stagedChanges.length}</span></span>
            ${stagedChanges.length ? `<i class="ri-subtract-line git-action-icon" title="Unstage All" data-git-action="unstage-all"></i>` : ''}
        </div>
        <div class="git-file-list">${stagedChanges.length ? stagedChanges.map(c => gitFileRow(c, true)).join('') : `<div class="git-empty-hint">No staged changes</div>`}</div>
        <div class="git-section-header">
            <span>CHANGES <span class="git-count-badge">${unstagedChanges.length}</span></span>
            ${unstagedChanges.length ? `<span><i class="ri-arrow-go-back-line git-action-icon" title="Discard All Changes" data-git-action="discard-all"></i><i class="ri-add-line git-action-icon" title="Stage All" data-git-action="stage-all"></i></span>` : ''}
        </div>
        <div class="git-file-list">${unstagedChanges.length ? unstagedChanges.map(c => gitFileRow(c, false)).join('') : `<div class="git-empty-hint">No changes - working tree clean</div>`}</div>
        ${ignoredPaths && ignoredPaths.length ? `
        <div style="padding:0 15px; margin-top:4px;">${gitSectionHeader('ignoredFiles', 'IGNORED', ignoredPaths.length, uiState)}</div>
        ${gitSectionOpen(uiState, 'ignoredFiles') ? `<div class="git-file-list">${ignoredPaths.map(p => `
            <div class="git-file-row git-file-row-ignored">
                <i class="ri-eye-off-line" style="width:16px; text-align:center; color:var(--text-muted);"></i>
                <span class="git-file-name" title="${gitEsc(p)}">${gitEsc(p.split('/').pop())}</span>
                <span class="git-file-path" title="${gitEsc(p)}">${gitEsc(p.slice(0, p.length - p.split('/').pop().length - 1) || '/')}</span>
            </div>`).join('')}</div>` : ''}
        ` : ''}
        ${!hasGitignore ? `
        <div class="git-file-row" data-git-action="create-gitignore" style="cursor:pointer;">
            <i class="ri-file-shield-2-line" style="width:16px; text-align:center; color:var(--icon-gray);"></i>
            <span class="git-file-name">No .gitignore yet - add common ignores</span>
        </div>` : ''}
        <div class="git-section-header" style="margin-top:6px;"><span>STASH</span></div>
        <div class="git-file-list"><div class="git-file-row" data-git-action="stash" style="cursor:pointer;"><i class="ri-inbox-archive-line" style="width:16px; text-align:center; color:var(--icon-gray);"></i><span class="git-file-name">Stash all changes</span></div></div>
    `;
}
// branchLabels: array of branch names whose ref currently points exactly at
// this commit (there can be more than one - two branches with no divergent
// commits of their own point at the same tip). graphCellHtml is this row's
// pre-rendered lane SVG from gitRenderGraphCell, or '' when the graph is off.
function gitCommitRow(sha, commit, uiState, branchLabels, graphCellHtml, isTip, tagsAtSha, repo) {
    const expanded = uiState.expandedCommits.has(sha);
    const isMerge = commit.parents.length > 1;
    const labels = (branchLabels && branchLabels.length)
        ? `<span class="git-branch-labels">${branchLabels.map(b => `<span class="git-branch-pill">${gitEsc(b)}</span>`).join('')}</span>`
        : '';
    const tagPills = (tagsAtSha && tagsAtSha.length)
        ? `<span class="git-branch-labels">${tagsAtSha.map(t => {
            const ann = repo.tags[t].annotation;
            const title = ann ? gitEsc(ann.message || '') : 'Lightweight tag';
            return `<span class="git-tag-pill" title="${title}"><i class="ri-price-tag-3-fill"></i>${gitEsc(t)}<i class="ri-close-line git-tag-pill-x" data-git-action="delete-tag" data-tag-name="${gitEsc(t)}" title="Delete tag"></i></span>`;
        }).join('')}</span>`
        : '';
    return `
        <div class="git-commit-row">
            <div class="git-commit-main" data-git-action="toggle-commit" data-commit-id="${sha}">
                ${graphCellHtml || ''}
                <i class="ri-arrow-right-s-fill git-arrow-icon ${expanded ? 'open' : ''}"></i>
                <div class="git-commit-info">
                    <div class="git-commit-msg">${labels}${tagPills}${gitEsc(commit.message)}</div>
                    <div class="git-commit-meta">${gitShortSha(sha)} \u00b7 ${gitRelativeTime(commit.timestamp)} \u00b7 ${gitEsc(commit.author || 'You')} \u00b7 ${commit.files.length} file${commit.files.length === 1 ? '' : 's'}${isMerge ? ' \u00b7 merge' : ''}</div>
                </div>
                <i class="ri-history-line git-action-icon" title="Restore files to this commit (history kept as-is)" data-git-action="restore-commit" data-commit-id="${sha}"></i>
            </div>
            ${expanded ? `<div class="git-commit-files">${commit.files.map(f => {
                const meta = getFileIconAndColor(f.name, false);
                return `<div class="git-file-row" data-git-action="commit-file-diff" data-commit-id="${sha}" data-path="${gitEsc(f.path)}">
                    <i class="${meta.icon}" style="color:${meta.color}; font-size:13px; width:16px; text-align:center;"></i>
                    <span class="git-file-name">${gitEsc(f.name)}</span>
                    <span class="git-file-path"></span>
                    ${gitStatusBadge(f.status)}
                </div>`;
            }).join('')}
            <div class="git-commit-ops">
                ${isTip ? `<span class="git-commit-op" data-git-action="amend-shortcut" data-commit-id="${sha}"><i class="ri-edit-2-line"></i> Amend</span>` : `<span class="git-commit-op" data-git-action="cherry-pick-commit" data-commit-id="${sha}"><i class="ri-git-commit-line"></i> Cherry-pick</span>`}
                <span class="git-commit-op" data-git-action="revert-commit" data-commit-id="${sha}"><i class="ri-arrow-go-back-line"></i> Revert</span>
                <span class="git-commit-op" data-git-action="new-tag" data-commit-id="${sha}"><i class="ri-price-tag-3-line"></i> Tag</span>
                <span class="git-commit-op-label">Reset:</span>
                <span class="git-commit-op" title="Move the branch pointer only - files and staged changes stay as they are" data-git-action="reset-commit" data-commit-id="${sha}" data-mode="soft">Soft</span>
                <span class="git-commit-op" title="Move the branch pointer, keep files, unstage everything" data-git-action="reset-commit" data-commit-id="${sha}" data-mode="mixed">Mixed</span>
                <span class="git-commit-op git-commit-op-danger" title="Move the branch pointer AND overwrite files to match - discards uncommitted changes" data-git-action="reset-commit" data-commit-id="${sha}" data-mode="hard">Hard</span>
            </div>
            </div>` : ''}
        </div>
    `;
}
// Renders the current branch's reflog, newest first - real git's own
// `git reflog` output order. Each entry shows what happened and offers to
// recover the branch back to that entry's resulting sha, except when that
// sha is already where the branch currently points (nothing to recover to)
// or the commit it points to is no longer in the local object store.
function gitRenderReflogSection(repo, config, dbName) {
    const entries = gitGetReflog(dbName, config.currentBranch).slice().reverse();
    if (!entries.length) return `<div class="git-empty-hint">No reflog entries yet for "${gitEsc(config.currentBranch)}"</div>`;
    const currentTip = repo.refs[config.currentBranch] || null;
    return `<div class="git-file-list">${entries.map(e => {
        const isCurrent = e.to === currentTip;
        const objectGone = e.to && !repo.objects[e.to];
        return `
        <div class="git-reflog-row">
            <i class="ri-history-line" style="color:var(--icon-gray); width:16px; text-align:center; flex-shrink:0;"></i>
            <div class="git-reflog-info">
                <div class="git-reflog-reason">${gitEsc(e.reason)}</div>
                <div class="git-reflog-meta">${gitRelativeTime(e.ts)} \u00b7 ${e.from ? gitShortSha(e.from) : '(none)'} \u2192 ${e.to ? gitShortSha(e.to) : '(none)'}</div>
            </div>
            ${isCurrent ? `<span class="git-reflog-current">current</span>`
                : objectGone ? `<span class="git-reflog-current" title="This commit is no longer in the local object store">unavailable</span>`
                : `<span class="git-conflict-action" data-git-action="reflog-recover" data-sha="${gitEsc(e.to || '')}">Recover</span>`}
        </div>`;
    }).join('')}</div>`;
}
function renderHistoryTab(repo, config, uiState, dbName) {
    const branches = Object.keys(repo.refs);
    const stash = repo.stash || [];
    // The graph spans every branch's history at once (not just the current
    // branch), same as `git log --graph --all` - this is what actually makes
    // divergence and merge points visible instead of only ever seeing one
    // branch's own linear slice of the DAG.
    const tips = branches.map(b => repo.refs[b]).filter(Boolean);
    const graphRows = gitBuildGraphRows(repo, tips);
    const laneCount = graphRows.length ? Math.max(...graphRows.flatMap(r => [r.lane].concat(r.extraParentLanes, r.joiningLanes))) + 1 : 1;
    const labelsBySha = {};
    branches.forEach(b => { const t = repo.refs[b]; if (t) (labelsBySha[t] = labelsBySha[t] || []).push(b); });
    const currentTipSha = repo.refs[config.currentBranch] || null;
    let activeBefore = [];
    const commitRowsHtml = graphRows.map(row => {
        const cell = gitRenderGraphCell(row, activeBefore, laneCount);
        activeBefore = row.activeLanesAfter;
        return gitCommitRow(row.sha, repo.objects[row.sha], uiState, labelsBySha[row.sha], cell, row.sha === currentTipSha, gitTagsAtSha(repo, row.sha), repo);
    }).join('');
    const commitShas = graphRows.map(r => r.sha); // kept for the count badge below
    return `
        <div class="git-branch-bar">
            <i class="ri-git-branch-line" style="color:var(--accent-blue);"></i>
            <select id="gitBranchSelect" class="git-select" data-git-change-action="switch-branch">
                ${branches.map(b => `<option value="${gitEsc(b)}" ${b === config.currentBranch ? 'selected' : ''}>${gitEsc(b)}</option>`).join('')}
            </select>
            <i class="ri-add-line git-action-icon" title="New Branch" data-git-action="new-branch"></i>
            <i class="ri-edit-line git-action-icon" title="Rename Current Branch" data-git-action="rename-branch"></i>
            ${branches.length > 1 ? `<i class="ri-delete-bin-line git-action-icon" title="Delete Current Branch" data-git-action="delete-branch" data-path="${gitEsc(config.currentBranch)}"></i>` : ''}
            <div class="hide-on-mobile" style="width:1px; height:14px; background:var(--border-color); margin:0 2px;"></div>
            <i class="ri-price-tag-3-line git-action-icon" title="Tag current commit" data-git-action="new-tag"></i>
            <i class="ri-price-tag-2-line git-action-icon" title="Create annotated tag on current commit" data-git-action="new-annotated-tag"></i>
        </div>
        ${branches.length > 1 ? `
        <div class="git-merge-bar">
            <i class="ri-git-merge-line" style="color:var(--icon-gray);"></i>
            <select id="gitMergeSelect" class="git-select">${branches.filter(b => b !== config.currentBranch).map(b => `<option value="${gitEsc(b)}">${gitEsc(b)}</option>`).join('')}</select>
            <button class="git-btn git-btn-small" data-git-action="do-merge">Merge into "${gitEsc(config.currentBranch)}"</button>
            <button class="git-btn git-btn-small git-btn-secondary" data-git-action="do-rebase" title="Replay this branch's own commits on top of the selected branch">Rebase onto</button>
        </div>
        <div class="git-hint" style="padding:0 15px 8px;">Merge does a real 3-way merge from the common ancestor. Rebase replays "${gitEsc(config.currentBranch)}"'s own commits on top of the selected branch instead, giving each one a new sha. Either way, conflicts get real markers to resolve in the Changes tab.</div>` : ''}
        ${stash.length ? `
        <div class="git-section-header"><span>STASHES <span class="git-count-badge">${stash.length}</span></span></div>
        <div class="git-file-list">${stash.map(s => `
            <div class="git-stash-row">
                <i class="ri-inbox-archive-line" style="color:var(--icon-gray); width:16px; text-align:center;"></i>
                <span class="git-file-name">${gitRelativeTime(s.timestamp)}</span>
                <span class="git-file-path">${s.files.length} file(s) on ${gitEsc(s.branch)}</span>
                <div class="git-file-actions">
                    <i class="ri-delete-bin-line git-action-icon" title="Drop Stash" data-git-action="stash-drop" data-stash-id="${s.id}"></i>
                    <i class="ri-inbox-unarchive-line git-action-icon" title="Apply & Remove" data-git-action="stash-pop" data-stash-id="${s.id}"></i>
                </div>
            </div>`).join('')}</div>` : ''}
        <div style="padding:0 15px; margin-top:4px; border-top:1px solid var(--border-color);">${gitSectionHeader('reflog', `REFLOG (${gitEsc(config.currentBranch)})`, undefined, uiState)}</div>
        ${gitSectionOpen(uiState, 'reflog') ? gitRenderReflogSection(repo, config, dbName) : ''}
        <div class="git-section-header"><span>COMMITS <span class="git-count-badge">${commitShas.length}</span></span></div>
        <div class="git-commit-list">${commitShas.length ? commitRowsHtml : `<div class="git-empty-hint">No commits yet</div>`}</div>
    `;
}
// --- Shared render bits --------------------------------------------------------
function gitResultBox(ui, key) {
    const r = ui.results[key];
    if (!r) return '';
    const icon = r.level === 'error' ? 'ri-error-warning-line' : r.level === 'success' ? 'ri-checkbox-circle-line' : 'ri-loader-4-line';
    const spin = r.level === 'info' ? ' git-spin' : '';
    const id = key === 'remote' ? ' id="gitRemoteStatus"' : '';
    const link = gitSafeGithubUrl(r.url) ? `<a href="${gitEsc(r.url)}" target="_blank" rel="noopener noreferrer">${gitEsc(r.linkText || 'View on GitHub')}</a>` : '';
    return `<div class="git-result git-result-${r.level}"${id}><i class="${icon}${spin}"></i><span class="git-result-text">${gitEsc(r.text)}</span>${link}</div>`;
}
function gitSectionHeader(id, title, count, ui) {
    const open = gitSectionOpen(ui, id);
    return `<div class="git-collapsible-header" data-git-action="toggle-section" data-section="${id}"><i class="ri-arrow-right-s-line git-arrow-icon${open ? ' open' : ''}"></i><span>${gitEsc(title)}</span>${count !== undefined ? `<span class="git-count-badge">${count}</span>` : ''}</div>`;
}
function gitRelDays(ts) {
    if (!ts) return '';
    const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
    if (days <= 0) return 'today'; if (days === 1) return 'yesterday'; if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
}

// --- Config tab: token/auth, GitHub profile, local profile, commit identity ---
function renderConfigTab(dbName, ui) {
    const token = gitGetToken();
    const gh = gitGetGhProfile();
    const profile = gitGetLocalProfile();
    const identity = gitResolveIdentity(dbName);
    const authResult = gitResultBox(ui, 'auth');

    const ghCard = gh ? `
        <div class="git-gh-card">
            <img class="git-gh-avatar" src="${gitEsc(gitSafeAvatarUrl(gh.avatar_url))}" alt="" onerror="this.style.visibility='hidden'">
            <div class="git-gh-card-info">
                <div class="git-gh-card-name">${gitEsc(gh.name || gh.login)}</div>
                <div class="git-gh-card-login">@${gitEsc(gh.login)} ${gitSafeGithubUrl(gh.html_url) ? `<a href="${gitEsc(gh.html_url)}" target="_blank" rel="noopener noreferrer">${gitEsc(gh.html_url.replace('https://', ''))}</a>` : ''}</div>
                <div class="git-gh-card-meta">${gh.public_repos != null ? `${gh.public_repos} public repos` : ''}${gh.followers != null ? ` &middot; ${gh.followers} followers` : ''}</div>
                ${gh.scopes && gh.scopes.length ? `<div class="git-gh-card-scopes">${gh.scopes.map(s => `<span class="git-scope-pill">${gitEsc(s)}</span>`).join('')}</div>`
                  : gh.scopes && gh.scopes.length === 0 ? `<div class="git-hint" style="padding:0; margin-top:4px;">Token has no classic scopes (likely a fine-grained token).</div>` : ''}
            </div>
        </div>
        ${gitTokenLocked() ? `<div class="git-hint" style="margin:8px 0;"><i class="ri-lock-line"></i> Your GitHub token is still in My Keys, which is locked. <a href="#" data-git-action="unlock-keys">Unlock My Keys</a> ${gitDevice() ? 'once and it moves to this device\'s key, so you will not need to unlock it again to push or pull.' : 'to push, pull or use GitHub.'}</div>` : ''}
        ${gitTokenProblem[gitWinId()] ? `<div class="git-hint" style="margin:8px 0;"><i class="ri-error-warning-line"></i> ${gitEsc(gitNoTokenMessage())}</div>` : ''}
        ${gitLegacyPlainToken() && (!gitDevice() || gitTokenLoaded[gitWinId()]) ? `<div class="git-hint" style="margin:8px 0;"><i class="ri-error-warning-line"></i> This token is still saved unencrypted in this browser. <a href="#" data-git-action="unlock-keys">Unlock My Keys</a> (or create it) and it will be moved into the vault.</div>` : ''}
        <div class="git-btn-row">
            <button class="git-btn git-btn-secondary" data-git-action="verify-token" ${ui.busy.auth ? 'disabled' : ''}><i class="ri-refresh-line"></i> Re-verify</button>
            <button class="git-btn git-btn-danger" data-git-action="disconnect-github"><i class="ri-logout-box-line"></i> Disconnect</button>
        </div>
        <div class="git-hint" style="margin-top:6px;">Verified ${gitRelDays(gh.verifiedAt)}.</div>
        ${gitSectionOpen(ui, 'replaceToken') ? `
        <div class="git-collapsible-header" data-git-action="toggle-section" data-section="replaceToken" style="margin-top:10px;"><i class="ri-arrow-right-s-line git-arrow-icon open"></i><span>Replace token</span></div>
        <div class="git-field-label" style="margin-top:6px;">New GitHub Personal Access Token</div>
        <input type="password" id="gitTokenInput" data-git-keep class="git-input" placeholder="ghp_... or github_pat_..." value="${gitEsc(gitDraft(ui, 'gitTokenInput', ''))}">
        <div class="git-btn-row" style="margin-top:6px;"><button class="git-btn" data-git-action="connect-github" ${ui.busy.auth ? 'disabled' : ''}>${ui.busy.auth ? 'Verifying...' : 'Save & Verify'}</button></div>
        ` : `<div class="git-collapsible-header" data-git-action="toggle-section" data-section="replaceToken"><i class="ri-arrow-right-s-line git-arrow-icon"></i><span>Replace token</span></div>`}
    ` : `
        <div class="git-field-label">GitHub Personal Access Token</div>
        <input type="password" id="gitTokenInput" data-git-keep class="git-input" placeholder="ghp_... or github_pat_..." value="${gitEsc(gitDraft(ui, 'gitTokenInput', token))}">
        ${gitTokenProblem[gitWinId()] ? `<div class="git-hint"><i class="ri-error-warning-line"></i> ${gitEsc(gitNoTokenMessage())}</div>` : ''}
        <div class="git-hint">${gitDevice() ? 'Stored encrypted on this device with a key the browser keeps for CodeMini, for this window/profile only. It stays available when My Keys is locked.' : 'Stored encrypted in your My Keys vault, for this window/profile only (unlock the vault to save or use it).'} Needs the "repo" scope (and "workflow" if you push workflow files). <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=CodeMini" target="_blank" rel="noopener noreferrer">Create one</a></div>
        <div class="git-btn-row" style="margin-top:8px;"><button class="git-btn" data-git-action="connect-github" ${ui.busy.auth ? 'disabled' : ''}>${ui.busy.auth ? 'Verifying...' : 'Save & Authenticate'}</button></div>
    `;

    const statsD = gitRepoStats(dbName);
    const localCard = `
        <div class="git-profile-card">
            <div class="git-profile-avatar"><i class="ri-user-line"></i></div>
            <div class="git-gh-card-info">
                <div class="git-gh-card-name">${gitEsc(profile.displayName)}</div>
                <div class="git-gh-card-login">${gitEsc(profile.username)} &middot; ${gitEsc(profile.email)}</div>
                <div class="git-gh-card-meta">${profile.isProfile ? '<i class="ri-shield-user-line"></i> Isolated Profile' : '<i class="ri-map-pin-2-line"></i> Native Window'}${profile.memberSince ? ` &middot; since ${gitEsc(profile.memberSince)}` : ''}</div>
            </div>
        </div>
        <div class="git-hint">This mirrors the Profile page for this window - open Profile to rename it or switch windows.</div>
        <div class="git-field-label" style="margin-top:10px;">Local repository info</div>
        <div class="git-kv-grid">
            <span>Database</span><strong>${gitEsc(profile.database)}</strong>
            <span>Branches</span><strong>${statsD.branches}</strong>
            <span>Tags</span><strong>${statsD.tags}</strong>
            <span>Commits (current branch)</span><strong>${statsD.commitsOnBranch}</strong>
            <span>Commits (total, all branches)</span><strong>${statsD.totalCommits}</strong>
            <span>Stashes</span><strong>${statsD.stashes}</strong>
            <span>Local storage used</span><strong>~${statsD.sizeKb} KB</strong>
        </div>
    `;

    const identityResult = gitResultBox(ui, 'identity');
    const idOption = (value, label, sub, disabled) => `
        <label class="git-radio-row ${disabled ? 'disabled' : ''}">
            <input type="radio" name="gitIdentitySource" value="${value}" ${identity.source === value ? 'checked' : ''} ${disabled ? 'disabled' : ''} data-git-change-action="identity-source">
            <span><strong>${gitEsc(label)}</strong><br><span class="git-hint" style="padding:0;">${sub}</span></span>
        </label>`;
    const identitySection = `
        <div class="git-field-label">Commit identity for this repository</div>
        <div class="git-hint" style="margin-bottom:6px;">Used as the author on new commits, merges and pulls.</div>
        ${idOption('profile', 'App profile (default)', `${gitEsc(profile.username)} &lt;${gitEsc(profile.email)}&gt;`)}
        ${idOption('github', 'Connected GitHub account', gh ? `${gitEsc(gh.name || gh.login)} &lt;${gitEsc(gh.email || gitGithubNoreplyEmail(gh))}&gt;` : 'Connect GitHub above to use this', !gh)}
        ${idOption('custom', 'Custom', identity.source === 'custom' ? `${gitEsc(identity.name)}${identity.email ? ` &lt;${gitEsc(identity.email)}&gt;` : ''}` : 'Type a name and email')}
        ${identity.source === 'custom' ? `
        <div style="margin-top:8px;">
            <input type="text" id="gitIdentityName" data-git-keep class="git-input" placeholder="Name" value="${gitEsc(gitDraft(ui, 'gitIdentityName', identity.name))}">
            <input type="text" id="gitIdentityEmail" data-git-keep class="git-input" placeholder="Email (optional)" value="${gitEsc(gitDraft(ui, 'gitIdentityEmail', identity.email))}">
            <button class="git-btn git-btn-secondary" style="margin-top:2px;" data-git-action="save-identity">Save Identity</button>
        </div>` : ''}
        ${identityResult}
    `;

    return `
        <div class="git-remote-section">
            <div class="git-field-label" style="font-size:12px; margin-bottom:8px;"><i class="ri-github-fill"></i> GitHub Account</div>
            ${authResult}
            ${ghCard}
        </div>
        <div class="git-tab-sep"></div>
        <div class="git-remote-section">
            <div class="git-field-label" style="font-size:12px; margin-bottom:8px;"><i class="ri-user-settings-line"></i> Local Profile</div>
            ${localCard}
        </div>
        <div class="git-tab-sep"></div>
        <div class="git-remote-section">
            <div class="git-field-label" style="font-size:12px; margin-bottom:8px;"><i class="ri-id-card-line"></i> Commit Identity</div>
            ${identitySection}
        </div>
    `;
}

// --- Remote tab: push/pull, repositories, new/fork, issues, PRs, log ---------
function renderRemoteTab(dbName, ui) {
    const gh = gitGetGhProfile();
    const hasToken = !!gitGetToken();
    const savedRepo = localStorage.getItem(gitStorageKey(dbName, 'remoteRepo')) || '';
    const savedBranch = localStorage.getItem(gitStorageKey(dbName, 'remoteBranch')) || 'main';
    const repoInputVal = gitDraft(ui, 'gitRepoInput', savedRepo);
    const ref = gitParseRepoRef(repoInputVal);
    const state = gitGHState();

    if (!hasToken) {
        return `
        <div class="git-remote-section">
            <div class="git-empty-hint" style="padding:20px 0;">
                <i class="ri-github-fill" style="font-size:28px; display:block; margin-bottom:8px; color:var(--icon-gray);"></i>
                Connect your GitHub account in the <strong>Config</strong> tab to push, pull, and manage repositories.
            </div>
            <button class="git-btn" data-git-action="switch-tab" data-tab="config">Go to Config</button>
        </div>`;
    }

    const branchList = ref ? (state.branches[ref.full] || []) : [];
    const tracking = gitGetRemoteTracking(dbName, savedBranch);
    const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
    const localTip = repo.refs[config.currentBranch] || null;
    let trackingLine = '';
    if (tracking) {
        const localAhead = localTip ? gitCountAhead(repo, localTip, tracking.branchSha) : 0;
        trackingLine = `<div class="git-hint" style="margin-top:8px;"><i class="ri-git-branch-line"></i> Last checked ${gitRelativeTime(tracking.fetchedAt)}: ${localAhead > 0 ? `${localAhead} local commit${localAhead === 1 ? '' : 's'} not yet pushed` : 'up to date with the last fetch'}</div>`;
    }
    const syncSection = `
        <div class="git-remote-section">
            <div class="git-field-label">Repository</div>
            <input type="text" id="gitRepoInput" data-git-keep class="git-input" list="gitBranchDatalist" placeholder="owner/repo" value="${gitEsc(repoInputVal)}">
            <div class="git-field-label" style="margin-top:6px;">Branch</div>
            <input type="text" id="gitRemoteBranchInput" data-git-keep class="git-input" list="gitRemoteBranchList" placeholder="main" value="${gitEsc(gitDraft(ui, 'gitRemoteBranchInput', savedBranch))}">
            ${branchList.length ? `<datalist id="gitRemoteBranchList">${branchList.map(b => `<option value="${gitEsc(b)}">`).join('')}</datalist>` : ''}
            <div class="git-remote-actions">
                <button class="git-btn" data-git-action="push" ${ui.busy.sync ? 'disabled' : ''}><i class="ri-upload-cloud-2-line"></i> Push</button>
                <button class="git-btn git-btn-secondary" data-git-action="pull" ${ui.busy.sync ? 'disabled' : ''}><i class="ri-download-cloud-2-line"></i> Pull</button>
                <button class="git-btn git-btn-secondary" data-git-action="fetch" title="Check the remote without changing any files" ${ui.busy.sync ? 'disabled' : ''}><i class="ri-refresh-line"></i> Fetch</button>
            </div>
            ${gitResultBox(ui, 'remote')}
            ${trackingLine}
            <div class="git-hint" style="margin-top:10px;">Push syncs your current commit's files up to the repo. Pull replaces local files with the repo's and records the result as a new commit here, so History stays meaningful. Fetch only checks what's on the remote.</div>
        </div>`;

    const r = state.repos;
    const reposOpen = gitSectionOpen(ui, 'repos');
    const reposBody = !reposOpen ? '' : `
        <div class="git-scope-toggle">
            <button class="git-chip ${r.scope === 'owner' ? 'active' : ''}" data-git-action="repos-scope" data-scope="owner">Owned by me</button>
            <button class="git-chip ${r.scope === 'all' ? 'active' : ''}" data-git-action="repos-scope" data-scope="all">All accessible</button>
            <button class="git-icon-btn" title="Reload" data-git-action="repos-reload" ${r.loading ? 'disabled' : ''}><i class="ri-refresh-line ${r.loading ? 'git-spin' : ''}"></i></button>
        </div>
        ${r.error ? `<div class="git-result git-result-error"><i class="ri-error-warning-line"></i><span class="git-result-text">${gitEsc(r.error)}</span></div>` : ''}
        <div class="git-repo-list">
            ${r.items.map(repo => `
                <div class="git-repo-row ${repo.full_name.toLowerCase() === (ref ? ref.full.toLowerCase() : '') ? 'active' : ''}">
                    <i class="${repo.private ? 'ri-lock-line' : 'ri-git-repository-line'}" style="color:var(--icon-gray); width:16px; text-align:center; flex-shrink:0;"></i>
                    <div style="min-width:0; flex:1;">
                        <div class="git-file-name" title="${gitEsc(repo.full_name)}">${gitEsc(repo.full_name)}${repo.fork ? ' <span class="git-hint-inline">fork</span>' : ''}</div>
                        <div class="git-file-path">${repo.description ? gitEsc(repo.description).slice(0, 70) : gitEsc(repo.default_branch)} ${repo.updated ? `&middot; ${gitRelDays(repo.updated)}` : ''}</div>
                    </div>
                    <div class="git-file-actions">
                        ${gitSafeGithubUrl(repo.html_url) ? `<a href="${gitEsc(repo.html_url)}" target="_blank" rel="noopener noreferrer" title="Open on GitHub"><i class="ri-external-link-line git-action-icon"></i></a>` : ''}
                        <i class="ri-download-2-line git-action-icon" title="Use as remote" data-git-action="use-repo" data-repo="${gitEsc(repo.full_name)}" data-branch="${gitEsc(repo.default_branch)}"></i>
                    </div>
                </div>`).join('') || (r.loading ? '' : `<div class="git-empty-hint">No repositories found.</div>`)}
            ${r.loading ? `<div class="git-empty-hint"><i class="ri-loader-4-line git-spin"></i> Loading...</div>` : ''}
        </div>
        ${r.hasMore && !r.loading ? `<button class="git-btn git-btn-secondary" style="margin-top:6px;" data-git-action="repos-more">Load more</button>` : ''}
    `;

    const newRepoOpen = gitSectionOpen(ui, 'newRepo');
    const newRepoBody = !newRepoOpen ? '' : `
        <input type="text" id="gitNewRepoName" data-git-keep class="git-input" placeholder="Repository name" value="${gitEsc(gitDraft(ui, 'gitNewRepoName', ''))}">
        <input type="text" id="gitNewRepoDesc" data-git-keep class="git-input" placeholder="Description (optional)" value="${gitEsc(gitDraft(ui, 'gitNewRepoDesc', ''))}">
        <label class="git-check-row"><input type="checkbox" id="gitNewRepoPrivate" data-git-keep ${gitFieldOrDefaultChecked(ui, 'gitNewRepoPrivate', true)}> Private</label>
        <label class="git-check-row"><input type="checkbox" id="gitNewRepoReadme" data-git-keep ${gitFieldOrDefaultChecked(ui, 'gitNewRepoReadme', true)}> Initialize with a README</label>
        <button class="git-btn" style="margin-top:4px;" data-git-action="create-repo" ${ui.busy.createRepo ? 'disabled' : ''}>${ui.busy.createRepo ? 'Creating...' : 'Create Repository'}</button>
        ${gitResultBox(ui, 'newRepo')}
    `;

    const forkOpen = gitSectionOpen(ui, 'fork');
    const forkBody = !forkOpen ? '' : `
        <input type="text" id="gitForkRepoInput" data-git-keep class="git-input" placeholder="owner/repo to fork" value="${gitEsc(gitDraft(ui, 'gitForkRepoInput', ''))}">
        <button class="git-btn" style="margin-top:4px;" data-git-action="fork-repo" ${ui.busy.fork ? 'disabled' : ''}>${ui.busy.fork ? 'Forking...' : 'Fork Repository'}</button>
        ${gitResultBox(ui, 'fork')}
    `;

    const issueOpen = gitSectionOpen(ui, 'issue');
    const issueBody = !issueOpen ? '' : `
        <input type="text" id="gitIssueRepo" data-git-keep class="git-input" placeholder="owner/repo" value="${gitEsc(gitDraft(ui, 'gitIssueRepo', ref ? ref.full : ''))}">
        <input type="text" id="gitIssueTitle" data-git-keep class="git-input" placeholder="Title" value="${gitEsc(gitDraft(ui, 'gitIssueTitle', ''))}">
        <textarea id="gitIssueBody" data-git-keep class="git-input git-textarea-sm" placeholder="Description (optional, Markdown)">${gitEsc(gitDraft(ui, 'gitIssueBody', ''))}</textarea>
        <input type="text" id="gitIssueLabels" data-git-keep class="git-input" placeholder="Labels, comma separated (optional)" value="${gitEsc(gitDraft(ui, 'gitIssueLabels', ''))}">
        <button class="git-btn" style="margin-top:4px;" data-git-action="create-issue" ${ui.busy.issue ? 'disabled' : ''}>${ui.busy.issue ? 'Creating...' : 'Create Issue'}</button>
        ${gitResultBox(ui, 'issue')}
    `;

    const prOpen = gitSectionOpen(ui, 'pr');
    const prBody = !prOpen ? '' : `
        <input type="text" id="gitPrRepo" data-git-keep class="git-input" placeholder="owner/repo" value="${gitEsc(gitDraft(ui, 'gitPrRepo', ref ? ref.full : ''))}">
        <input type="text" id="gitPrTitle" data-git-keep class="git-input" placeholder="Title" value="${gitEsc(gitDraft(ui, 'gitPrTitle', ''))}">
        <div style="display:flex; gap:6px;">
            <input type="text" id="gitPrHead" data-git-keep class="git-input" placeholder="head (your branch)" value="${gitEsc(gitDraft(ui, 'gitPrHead', ''))}">
            <input type="text" id="gitPrBase" data-git-keep class="git-input" placeholder="base (e.g. main)" value="${gitEsc(gitDraft(ui, 'gitPrBase', 'main'))}">
        </div>
        <textarea id="gitPrBody" data-git-keep class="git-input git-textarea-sm" placeholder="Description (optional, Markdown)">${gitEsc(gitDraft(ui, 'gitPrBody', ''))}</textarea>
        <label class="git-check-row"><input type="checkbox" id="gitPrDraft" data-git-keep ${gitFieldOrDefaultChecked(ui, 'gitPrDraft', false)}> Create as draft</label>
        <button class="git-btn" style="margin-top:4px;" data-git-action="create-pr" ${ui.busy.pr ? 'disabled' : ''}>${ui.busy.pr ? 'Creating...' : 'Create Pull Request'}</button>
        ${gitResultBox(ui, 'pr')}
    `;

    const logOpen = gitSectionOpen(ui, 'log');
    const logEntries = gitGetLog(dbName).slice().reverse();
    const logBody = !logOpen ? '' : `
        <div class="git-btn-row" style="margin-bottom:6px;">
            <button class="git-btn git-btn-secondary" data-git-action="copy-log" ${logEntries.length ? '' : 'disabled'}><i class="ri-file-copy-line"></i> Copy JSON</button>
            <button class="git-btn git-btn-secondary" data-git-action="export-log" ${logEntries.length ? '' : 'disabled'}><i class="ri-download-2-line"></i> Export</button>
            <button class="git-btn git-btn-danger" data-git-action="clear-log" ${logEntries.length ? '' : 'disabled'}><i class="ri-delete-bin-line"></i></button>
        </div>
        <div class="git-log-list">
            ${logEntries.length ? logEntries.slice(0, 100).map(e => `
                <div class="git-log-row git-log-${e.level}">
                    <i class="${e.level === 'error' ? 'ri-error-warning-line' : e.level === 'success' ? 'ri-checkbox-circle-line' : 'ri-information-line'}"></i>
                    <div style="min-width:0; flex:1;">
                        <div class="git-log-msg">${gitEsc(e.message)}</div>
                        <div class="git-log-meta">${gitEsc(new Date(e.ts).toLocaleString())} &middot; ${gitEsc(e.action)}</div>
                    </div>
                </div>`).join('') : `<div class="git-empty-hint">No activity logged yet.</div>`}
            ${logEntries.length > 100 ? `<div class="git-hint" style="text-align:center;">Showing the most recent 100 of ${logEntries.length}. Export for the full log.</div>` : ''}
        </div>
    `;

    return `
        ${syncSection}
        <div class="git-tab-sep"></div>
        <div class="git-remote-section">
            ${gitSectionHeader('repos', 'Your Repositories', r.loaded ? r.items.length : undefined, ui)}
            ${reposBody}
        </div>
        <div class="git-remote-section">${gitSectionHeader('newRepo', 'New Repository', undefined, ui)}${newRepoBody}</div>
        <div class="git-remote-section">${gitSectionHeader('fork', 'Fork Repository', undefined, ui)}${forkBody}</div>
        <div class="git-remote-section">${gitSectionHeader('issue', 'New Issue', undefined, ui)}${issueBody}</div>
        <div class="git-remote-section">${gitSectionHeader('pr', 'New Pull Request', undefined, ui)}${prBody}</div>
        <div class="git-remote-section">${gitSectionHeader('log', 'Source Control Log', logEntries.length, ui)}${logBody}</div>
    `;
}
function gitFieldOrDefaultChecked(ui, id, fallback) { return gitFieldChecked(id, ui.drafts[id] !== undefined ? ui.drafts[id] : fallback) ? 'checked' : ''; }

function injectGitStyles() {
    if (document.getElementById('gitOverrides')) return;
    const style = document.createElement('style');
    style.id = 'gitOverrides';
    style.textContent = `
    .git-header { display:flex; justify-content:space-between; align-items:center; padding:13px 15px; background:var(--bg-white); position:sticky; top:0; z-index:2; }
    .git-header-title { font-weight:700; font-size:15px; color:var(--text-main); letter-spacing:-0.2px; }
    .git-header-icons { display:flex; gap:6px; align-items:center; font-size:18px; }
    .git-header-icons .git-action-icon { padding:3px; }
    .git-action-icon { cursor:pointer; opacity:0.7; padding:4px; border-radius:3px; color:var(--icon-gray); transition:opacity .15s, background-color .15s, color .15s; }
    .git-action-icon:hover { opacity:1; background:var(--bg-panel); color:var(--text-main); }
    .git-tabs { display:flex; background:var(--bg-white); border-bottom:1px solid var(--border-color); position:sticky; top:45px; z-index:2; }
    .git-tab { flex:1; text-align:center; padding:9px 6px; font-size:12px; font-weight:600; color:var(--text-muted); cursor:pointer; border-bottom:2px solid transparent; }
    .git-tab:hover { color:var(--text-main); }
    .git-tab.active { color:var(--accent-blue); border-bottom-color:var(--accent-blue); }
    .git-tab-content { flex:1; overflow-y:auto; padding-bottom:20px; white-space:normal; }
    .git-commit-box { padding:12px 15px; border-bottom:1px solid var(--border-color); }
    .git-commit-input { width:100%; box-sizing:border-box; min-height:56px; resize:vertical; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:4px; padding:8px 10px; font-family:var(--font-main); font-size:12px; color:var(--text-main); outline:none; }
    .git-commit-input:focus { border-color:var(--accent-blue); }
    .git-commit-prefixes { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
    .git-prefix-chip { font-size:10px; font-family:var(--font-mono); padding:2px 8px; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:10px; color:var(--text-muted); cursor:pointer; }
    .git-prefix-chip:hover { color:var(--accent-blue); border-color:var(--accent-blue); }
    .git-btn { width:100%; padding:8px; background:var(--accent-blue); color:var(--text-on-accent, #fff); border:none; border-radius:4px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; box-sizing:border-box; }
    .git-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .git-btn-secondary { background:var(--icon-gray); }
    .git-btn-small { width:auto; padding:5px 10px; margin-top:6px; flex-shrink:0; }
    .git-section-header { display:flex; justify-content:space-between; align-items:center; padding:10px 15px 6px; font-size:11px; font-weight:700; letter-spacing:0.4px; color:var(--text-muted); }
    .git-count-badge { background:var(--bg-panel); color:var(--text-muted); padding:1px 6px; border-radius:9px; font-size:10px; margin-left:4px; border:1px solid var(--border-color); }
    .git-file-list { display:flex; flex-direction:column; }
    .git-empty-hint { padding:8px 15px; font-size:12px; color:var(--text-muted); font-style:italic; }
    .git-file-row, .git-stash-row { display:flex; align-items:center; gap:8px; padding:5px 15px; cursor:pointer; }
    .git-file-row:hover, .git-stash-row:hover { background:var(--bg-panel); }
    .git-file-name { font-size:12px; color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; max-width:45%; }
    .git-file-path { font-size:10px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
    .git-file-actions { display:none; gap:4px; margin-left:auto; flex-shrink:0; }
    .git-file-row:hover .git-file-actions, .git-stash-row:hover .git-file-actions { display:flex; }
    .git-status-badge { font-size:10px; font-weight:700; font-family:var(--font-mono); border:1px solid; border-radius:3px; width:16px; height:16px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .git-reflog-row { display:flex; align-items:center; gap:8px; padding:6px 15px; border-bottom:1px dashed var(--border-color); }
    .git-reflog-info { flex:1; min-width:0; }
    .git-reflog-reason { font-size:11px; color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .git-reflog-meta { font-size:10px; color:var(--text-muted); font-family:var(--font-mono); margin-top:1px; }
    .git-reflog-current { font-size:9px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.3px; flex-shrink:0; }
    .git-branch-bar, .git-merge-bar { display:flex; align-items:center; gap:8px; padding:8px 12px; flex-wrap:wrap; }
    .git-select { flex:1; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:4px; padding:5px 8px; font-size:12px; color:var(--text-main); outline:none; min-width:60px; }
    /* .sidebar has white-space:nowrap, so any text block inside it must
       opt back into normal wrapping explicitly - without this the hint
       paragraphs rendered by renderHistoryTab/renderRemoteTab stretch the
       sidebar horizontally on one long unbroken line instead of wrapping. */
    .git-hint { font-size:10px; color:var(--text-muted); line-height:1.6; padding:0 15px; white-space:normal; word-break:break-word; overflow-wrap:break-word; }
    .git-hint a { color:var(--accent-blue); }
    .git-commit-list { display:flex; flex-direction:column; padding:0 0 10px; overflow-x:auto; }
    .git-commit-row { border-bottom:1px dashed var(--border-color); }
    .git-commit-main { display:flex; align-items:center; gap:6px; padding:8px 10px 8px 4px; cursor:pointer; }
    .git-commit-main:hover { background:var(--bg-panel); }
    .git-arrow-icon { transition:transform .15s; color:var(--icon-gray); flex-shrink:0; }
    .git-arrow-icon.open { transform:rotate(90deg); }
    .git-commit-info { flex:1; min-width:0; }
    .git-commit-msg { font-size:12px; color:var(--text-main); font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; align-items:center; gap:5px; }
    .git-commit-meta { font-size:10px; color:var(--text-muted); margin-top:1px; }
    .git-branch-labels { display:inline-flex; gap:4px; flex-shrink:0; }
    .git-branch-pill { font-size:9px; font-weight:700; padding:1px 6px; border-radius:8px; background:var(--accent-blue); color:var(--text-on-accent, #fff); white-space:nowrap; line-height:1.5; }
    .git-tag-pill { display:inline-flex; align-items:center; gap:3px; font-size:9px; font-weight:700; padding:1px 6px; border-radius:8px; background:var(--color-warning); color:#000; white-space:nowrap; line-height:1.5; }
    .git-tag-pill i:first-child { font-size:10px; }
    .git-tag-pill-x { display:none; font-size:11px !important; margin-left:1px; cursor:pointer; }
    .git-tag-pill:hover .git-tag-pill-x { display:inline; }
    .git-tag-pill-x:hover { opacity:0.6; }
    .git-commit-files { padding:4px 0 8px 26px; display:flex; flex-direction:column; }
    .git-commit-ops { display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:6px 0 4px 26px; border-top:1px dashed var(--border-color); margin-top:4px; }
    .git-commit-op { display:inline-flex; align-items:center; gap:3px; font-size:10px; font-weight:600; color:var(--text-muted); padding:3px 7px; border:1px solid var(--border-color); border-radius:4px; cursor:pointer; white-space:nowrap; }
    .git-commit-op:hover { color:var(--accent-blue); border-color:var(--accent-blue); }
    .git-commit-op-danger:hover { color:var(--color-danger); border-color:var(--color-danger); }
    .git-commit-op-label { font-size:10px; color:var(--text-muted); margin-left:4px; }
    .git-amend-toggle { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-muted); margin:2px 0 8px; cursor:pointer; user-select:none; }
    .git-amend-toggle input { margin:0; cursor:pointer; }
    .git-remote-section { padding:12px 15px; }
    .git-field-label { font-size:11px; font-weight:600; color:var(--text-muted); margin-bottom:4px; }
    .git-input { width:100%; box-sizing:border-box; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:4px; padding:7px 9px; font-size:12px; color:var(--text-main); outline:none; margin-bottom:4px; font-family:var(--font-mono); }
    .git-input:focus { border-color:var(--accent-blue); }
    .git-remote-actions { display:flex; gap:8px; margin-top:10px; }
    .git-remote-actions .git-btn { width:auto; flex:1; padding:7px; }
    .git-diff-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:10010; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; }
    .git-diff-box { background:var(--bg-white); border-radius:6px; width:100%; max-width:700px; max-height:80vh; display:flex; flex-direction:column; box-shadow:0 10px 40px rgba(0,0,0,0.3); overflow:hidden; transition:max-width 0.15s ease; }
    .git-diff-box-wide { max-width:min(1100px, 96vw); }
    .git-diff-header { display:flex; justify-content:space-between; align-items:center; padding:10px 16px; border-bottom:1px solid var(--border-color); font-size:13px; font-weight:600; color:var(--text-main); flex-shrink:0; gap:10px; }
    .git-diff-header > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .git-diff-header-actions { display:flex; align-items:center; gap:10px; flex-shrink:0; }
    .git-diff-view-toggle { display:flex; border:1px solid var(--border-color); border-radius:4px; overflow:hidden; font-size:11px; font-weight:600; }
    .git-diff-view-toggle span { padding:4px 9px; cursor:pointer; color:var(--text-muted); }
    .git-diff-view-toggle span.active { background:var(--accent-blue); color:var(--text-on-accent, #fff); }
    .git-diff-view-toggle span:not(.active):hover { background:var(--bg-panel); }
    .git-diff-body { overflow:auto; font-family:var(--font-mono); font-size:12px; padding:4px 0; }
    .git-diff-hunk-header { padding:3px 12px; color:var(--accent-blue); background:rgba(55,148,255,0.08); font-size:11px; white-space:pre; }
    .git-diff-gap { padding:4px 12px; color:var(--text-muted); cursor:pointer; display:flex; align-items:center; gap:5px; font-size:11px; background:var(--bg-panel); user-select:none; }
    .git-diff-gap:hover { color:var(--accent-blue); }
    .git-diff-row { display:flex; padding:0 12px; white-space:pre; }
    .git-diff-ln { width:34px; flex-shrink:0; text-align:right; padding-right:8px; opacity:0.45; user-select:none; }
    .git-diff-marker { width:14px; flex-shrink:0; opacity:0.6; user-select:none; }
    .git-diff-text { flex:1; overflow-x:auto; }
    .git-diff-added { background:rgba(46,160,67,0.15); color:var(--text-main); }
    .git-diff-removed { background:rgba(248,81,73,0.15); color:var(--text-main); }
    .git-diff-context { color:var(--text-muted); }
    .git-diff-binary { padding:40px 20px; text-align:center; color:var(--text-muted); font-size:13px; line-height:1.8; }
    .git-diff-sbs-row { display:flex; }
    .git-diff-sbs-side { flex:1; min-width:0; display:flex; padding:0 10px; white-space:pre; }
    .git-diff-sbs-side .git-diff-ln { width:30px; }
    .git-diff-sbs-side .git-diff-text { flex:1; overflow-x:auto; }
    .git-diff-sbs-side.git-diff-blank { background:var(--bg-panel); opacity:0.4; }
    .git-diff-sbs-row .git-diff-sbs-side:first-child { border-right:1px solid var(--border-color); }
    @media (max-width: 700px) { .git-diff-box-wide { max-width:100%; } .git-diff-sbs-side .git-diff-ln { width:22px; } }
    @media (max-width: 480px) { .git-file-actions { display:flex; } .git-file-name { max-width:35%; } }
    .git-merge-banner { display:flex; align-items:center; gap:8px; padding:9px 15px; font-size:12px; line-height:1.5; border-bottom:1px solid var(--border-color); }
    .git-merge-banner.has-conflicts { background:rgba(248,81,73,0.1); color:var(--text-main); }
    .git-merge-banner.has-conflicts i { color:var(--color-danger); }
    .git-merge-banner.ready { background:rgba(46,160,67,0.1); color:var(--text-main); }
    .git-merge-banner.ready i { color:var(--color-success); }
    .git-merge-banner span:not(.git-merge-abort) { flex:1; }
    .git-merge-abort { flex-shrink:0; cursor:pointer; font-size:11px; font-weight:600; color:var(--text-muted); padding:2px 8px; border:1px solid var(--border-color); border-radius:4px; white-space:nowrap; }
    .git-merge-abort:hover { color:var(--color-danger); border-color:var(--color-danger); }
    .git-conflict-row:hover { background:rgba(248,81,73,0.08); }
    .git-file-row-ignored { opacity:0.65; cursor:default; }
    .git-file-row-ignored:hover { background:transparent; }
    .git-conflict-action { font-size:10px; font-weight:600; color:var(--text-muted); padding:2px 6px; border:1px solid var(--border-color); border-radius:3px; cursor:pointer; white-space:nowrap; }
    .git-conflict-action:hover { color:var(--accent-blue); border-color:var(--accent-blue); }
    @media (max-width: 480px) { .git-conflict-row .git-file-actions { display:flex; } }
    .git-tab-sep { height:1px; background:var(--border-color); margin:4px 15px; }
    .git-btn-row { display:flex; gap:8px; flex-wrap:wrap; }
    .git-btn-row .git-btn { width:auto; flex:1; padding:7px; min-width:100px; }
    .git-btn-danger { background:transparent; border:1px solid var(--color-danger, #e5484d); color:var(--color-danger, #e5484d); }
    .git-btn-danger:hover { background:rgba(229,72,77,0.1); }
    .git-result { display:flex; align-items:center; gap:6px; padding:7px 9px; border-radius:4px; font-size:11.5px; line-height:1.5; margin-top:8px; background:var(--bg-panel); color:var(--text-main); word-break:break-word; }
    .git-result i { flex-shrink:0; font-size:14px; }
    .git-result a { margin-left:auto; flex-shrink:0; color:var(--accent-blue); white-space:nowrap; }
    .git-result-text { min-width:0; }
    .git-result-error { background:rgba(229,72,77,0.1); color:var(--color-danger, #e5484d); }
    .git-result-success { background:rgba(46,160,67,0.12); color:var(--text-main); }
    .git-result-success i { color:#2ea043; }
    .git-spin { animation: git-spin-kf 0.8s linear infinite; }
    @keyframes git-spin-kf { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
    .git-gh-card, .git-profile-card { display:flex; gap:10px; align-items:flex-start; padding:10px; background:var(--bg-panel); border-radius:6px; margin-bottom:8px; }
    .git-gh-avatar { width:42px; height:42px; border-radius:50%; flex-shrink:0; background:var(--border-color); object-fit:cover; }
    .git-profile-avatar { width:42px; height:42px; border-radius:50%; flex-shrink:0; background:var(--border-color); display:flex; align-items:center; justify-content:center; font-size:20px; color:var(--icon-gray); }
    .git-gh-card-info { min-width:0; flex:1; }
    .git-gh-card-name { font-size:13px; font-weight:600; color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .git-gh-card-login { font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:1px; }
    .git-gh-card-login a { color:var(--accent-blue); }
    .git-gh-card-meta { font-size:10.5px; color:var(--text-muted); margin-top:3px; }
    .git-gh-card-scopes { margin-top:5px; display:flex; flex-wrap:wrap; gap:4px; }
    .git-scope-pill { font-size:9.5px; padding:1px 6px; border-radius:8px; background:var(--border-color); color:var(--text-main); white-space:nowrap; }
    .git-kv-grid { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; font-size:11.5px; margin-top:4px; }
    .git-kv-grid span { color:var(--text-muted); }
    .git-kv-grid strong { color:var(--text-main); text-align:right; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .git-radio-row { display:flex; align-items:flex-start; gap:8px; padding:6px 2px; cursor:pointer; font-size:11.5px; }
    .git-radio-row.disabled { opacity:0.5; cursor:not-allowed; }
    .git-radio-row input { margin-top:3px; flex-shrink:0; accent-color:var(--accent-blue); }
    .git-hint-inline { font-size:9.5px; color:var(--text-muted); background:var(--border-color); padding:0 5px; border-radius:6px; }
    .git-check-row { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--text-main); padding:5px 0; cursor:pointer; }
    .git-check-row input { accent-color:var(--accent-blue); }
    .git-textarea-sm { min-height:52px; resize:vertical; font-family:inherit; }
    .git-collapsible-header { display:flex; align-items:center; gap:6px; padding:8px 0; cursor:pointer; font-size:11px; font-weight:600; color:var(--text-muted); letter-spacing:0.3px; text-transform:uppercase; user-select:none; }
    .git-collapsible-header:hover { color:var(--text-main); }
    .git-collapsible-header .git-count-badge { margin-left:auto; }
    .git-scope-toggle { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
    .git-chip { border:1px solid var(--border-color); background:var(--bg-panel); color:var(--text-muted); font-size:10.5px; padding:4px 9px; border-radius:12px; cursor:pointer; white-space:nowrap; }
    .git-chip.active { background:var(--accent-blue); border-color:var(--accent-blue); color:var(--text-on-accent, #fff); }
    .git-icon-btn { margin-left:auto; background:none; border:none; color:var(--icon-gray); cursor:pointer; font-size:15px; padding:2px 4px; flex-shrink:0; }
    .git-icon-btn:hover { color:var(--text-main); }
    .git-icon-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .git-repo-list { display:flex; flex-direction:column; gap:2px; max-height:260px; overflow-y:auto; }
    .git-repo-row { display:flex; align-items:center; gap:8px; padding:6px 4px; border-radius:4px; }
    .git-repo-row:hover { background:var(--bg-panel); }
    .git-repo-row.active { background:rgba(59,130,246,0.08); }
    .git-repo-row .git-file-actions { display:flex; opacity:1; }
    .git-repo-row .git-file-actions a { color:var(--icon-gray); display:flex; }
    .git-log-list { display:flex; flex-direction:column; gap:2px; max-height:320px; overflow-y:auto; }
    .git-log-row { display:flex; gap:7px; padding:6px 4px; border-bottom:1px dashed var(--border-color); font-size:11px; }
    .git-log-row i { flex-shrink:0; margin-top:1px; color:var(--icon-gray); }
    .git-log-error i { color:var(--color-danger, #e5484d); }
    .git-log-success i { color:#2ea043; }
    .git-log-msg { color:var(--text-main); word-break:break-word; }
    .git-log-meta { color:var(--text-muted); font-size:9.5px; margin-top:1px; }
    `;
    document.head.appendChild(style);
}

// --- Drag-to-resize ----------------------------------------------------------
// script.js injects a .sidebar-resizer into every .sidebar ONCE, at
// DOMContentLoaded. This sidebar's whole contents get replaced via innerHTML
// on every render, and the very first renders (git.js's own initial render
// plus restoreCurrentUIState) happen before IndexedDB has finished opening -
// that "No database yet" branch previously wiped the resizer with nothing to
// put it back, so the panel was permanently un-draggable after load.
// Rather than patch each innerHTML site, this is idempotent and self-healing:
// every render path calls it last, and it re-creates + re-wires the handle
// only if it's actually missing. Uses the same makeResizable helper and the
// same width rules/persistence key as the other sidebars in script.js.
function gitEnsureResizer(sidebar) {
    if (!sidebar || sidebar.querySelector('.sidebar-resizer')) return;
    const resizer = document.createElement('div');
    resizer.className = 'sidebar-resizer';
    sidebar.appendChild(resizer);
    if (typeof window.makeResizable !== 'function') return;
    let startWidth = 0;
    window.makeResizable(resizer, {
        cursor: 'ew-resize',
        onStart: () => { startWidth = sidebar.offsetWidth; sidebar.style.transition = 'none'; },
        onMove: (dx) => {
            let newWidth = startWidth + dx;
            if (newWidth < 150) newWidth = 150;
            if (newWidth > window.innerWidth * 0.6) newWidth = window.innerWidth * 0.6;
            document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
        },
        onEnd: () => {
            sidebar.style.transition = '';
            const winId = localStorage.getItem('codemini_active_window') || 'win_default';
            localStorage.setItem(`codemini_sidebar_width_${winId}`, sidebar.offsetWidth);
        }
    });
}

// --- Status bar branch indicator ---------------------------------------------
// The "main" item in the status bar used to be static text. It now shows the
// real current branch of whichever repo (profile/workspace db) is active, and
// opens a picker to switch/create branches - reusing the same operations the
// Source Control panel uses, so both stay consistent.
window.gitUpdateStatusBranch = function() {
    const label = document.getElementById('statusBranchName');
    const item = document.getElementById('statusBranch');
    const syncBadge = document.getElementById('statusBranchSync');
    if (!label) return;
    if (typeof db === 'undefined' || !db) { label.textContent = 'main'; if (syncBadge) syncBadge.textContent = ''; return; }
    const config = getGitConfig(db.name);
    const repo = getGitRepo(db.name);
    const name = config.currentBranch || 'main';
    label.textContent = name;
    if (item) item.title = `Branch: ${name} (click to switch)`;
    // Ahead-of-last-known-remote, from the cached tracking record only - never
    // triggers a network request itself. The count only ever changes here
    // when the record itself changes (after an explicit fetch/pull/push), so
    // this stays instant even though it's called on every render.
    if (syncBadge) {
        const savedBranch = localStorage.getItem(gitStorageKey(db.name, 'remoteBranch')) || 'main';
        const tracking = gitGetRemoteTracking(db.name, savedBranch);
        const localTip = repo.refs[name] || null;
        const ahead = (tracking && localTip) ? gitCountAhead(repo, localTip, tracking.branchSha) : 0;
        syncBadge.textContent = ahead > 0 ? `\u2191${ahead}` : '';
        syncBadge.title = ahead > 0 ? `${ahead} local commit${ahead === 1 ? '' : 's'} not pushed as of the last fetch/pull/push` : '';
    }
    // Keep the chosen name in sync if the picker is open.
    if (document.getElementById('gitBranchPicker')?.classList.contains('show')) gitRenderBranchPicker(repo, config);
};

function gitRenderBranchPicker(repo, config) {
    const picker = document.getElementById('gitBranchPicker');
    if (!picker) return;
    const names = Object.keys(repo.refs);
    picker.innerHTML =
        names.map(n => `
            <div class="dropdown-item" data-branch="${gitEsc(n)}">
                <i class="${n === config.currentBranch ? 'ri-check-line' : 'ri-git-branch-line'}"${n === config.currentBranch ? ' style="color:var(--accent-blue);"' : ''}></i>
                <span style="${n === config.currentBranch ? 'font-weight:600;' : ''}">${gitEsc(n)}</span>
            </div>`).join('') +
        `<div style="height:1px; background:var(--border-color); margin:4px 0;"></div>
         <div class="dropdown-item" data-branch-action="new"><i class="ri-add-line"></i> Create new branch...</div>
         <div class="dropdown-item" data-branch-action="panel"><i class="ri-git-repository-line"></i> Open Source Control</div>`;
}

function gitCloseBranchPicker() {
    document.getElementById('gitBranchPicker')?.classList.remove('show');
}

function gitToggleBranchPicker() {
    const item = document.getElementById('statusBranch');
    if (!item) return;
    if (typeof db === 'undefined' || !db) {
        if (window.showSuccessToast) window.showSuccessToast('No workspace loaded yet');
        return;
    }
    let picker = document.getElementById('gitBranchPicker');
    if (!picker) {
        picker = document.createElement('div');
        picker.id = 'gitBranchPicker';
        picker.className = 'explorer-dropdown';
        // .explorer-dropdown opens downward (top:100%); the status bar sits at
        // the bottom of the window, so flip it to open upward, anchored to the
        // item, and let long branch lists scroll instead of running off-screen.
        picker.style.cssText = 'top:auto; bottom:100%; left:0; margin:0 0 6px 0; max-height:50vh; overflow-y:auto; z-index:10010;';
        item.style.position = 'relative';
        item.appendChild(picker);
        picker.addEventListener('click', (e) => {
            e.stopPropagation();
            const row = e.target.closest('[data-branch], [data-branch-action]');
            if (!row) return;
            gitCloseBranchPicker();
            if (row.dataset.branch) {
                gitSwitchBranch(row.dataset.branch);
            } else if (row.dataset.branchAction === 'new') {
                gitNewBranch();
            } else if (row.dataset.branchAction === 'panel') {
                const sb = document.getElementById('sourceControlSidebar');
                if (sb && !sb.classList.contains('open')) document.getElementById('menuSource')?.click();
            }
        });
    }
    const willShow = !picker.classList.contains('show');
    if (willShow) {
        gitRenderBranchPicker(getGitRepo(db.name), getGitConfig(db.name));
        picker.classList.add('show');
    } else {
        picker.classList.remove('show');
    }
}

// --- Main render entrypoint --------------------------------------------------
window.gitStateRegistry = window.gitStateRegistry || {};
window.renderGitPanel = async function() {
    const sidebar = document.getElementById('sourceControlSidebar');
    if (!sidebar) return;
    if (typeof db === 'undefined' || !db) {
        sidebar.innerHTML = `<div style="padding:20px; color:var(--text-muted); font-size:13px;">No database available yet.</div>`;
        gitEnsureResizer(sidebar);
        window.gitUpdateStatusBranch();
        return;
    }
    const database = db;
    const dbName = database.name;
    const uiState = gitUi();
    gitHydrateToken();
    gitAutoVerifyToken();
    await gitHydrateObjectCache(database);

    const config = getGitConfig(dbName);
    const repo = getGitRepo(dbName);
    if (!Object.prototype.hasOwnProperty.call(repo.refs, config.currentBranch)) {
        config.currentBranch = Object.keys(repo.refs)[0] || 'main';
        if (!Object.prototype.hasOwnProperty.call(repo.refs, config.currentBranch)) repo.refs[config.currentBranch] = null;
        saveGitConfig(dbName, config);
        saveGitRepo(dbName, repo);
    }
    const staged = getStagedPaths(dbName);

    const workingTree = await gitGetWorkingTree(database);
    const headTree = gitComputeHeadTree(repo, config.currentBranch);
    const hasGitignore = workingTree.has('/.gitignore');
    const ignoreRules = gitGetIgnoreRules(workingTree);
    const rawChanges = gitComputeChanges(workingTree, headTree);
    // An already-staged path stays visible even if it happens to match an
    // ignore rule (staged takes precedence over ignored, same as real git's
    // index) - only NEW, not-yet-staged additions are hidden by .gitignore.
    const ignoredNewPaths = rawChanges.filter(c => !staged.includes(c.path) && c.status === 'added' && gitIsIgnored(c.path, ignoreRules)).map(c => c.path);
    const allChanges = rawChanges.filter(c => staged.includes(c.path) || !(c.status === 'added' && gitIsIgnored(c.path, ignoreRules)));
    const pendingMergeRaw = gitGetPendingMerge(dbName);
    const pendingRebaseRaw = gitGetPendingRebase(dbName);
    // A pending rebase only has real conflict markers in the working tree
    // while it's actually stopped on one (conflictPaths non-empty) - between
    // commits, or before the first one, there's nothing to resolve, so it
    // shouldn't present as a conflict state to the Changes tab at all.
    const pendingMerge = pendingMergeRaw ? pendingMergeRaw
        : (pendingRebaseRaw && pendingRebaseRaw.conflictPaths.length > 0) ? {
            kind: 'rebase', targetBranch: pendingRebaseRaw.branch, sourceBranch: `${pendingRebaseRaw.branch} onto ${pendingRebaseRaw.ontoBranch}`,
            conflictPaths: pendingRebaseRaw.conflictPaths, unresolvedBinary: pendingRebaseRaw.unresolvedBinary,
            targetSha: pendingRebaseRaw.newTip, sourceSha: pendingRebaseRaw.originalShas[pendingRebaseRaw.nextIndex],
            progress: `commit ${pendingRebaseRaw.nextIndex + 1} of ${pendingRebaseRaw.originalShas.length}`
        } : null;
    const unresolvedConflicts = gitFindUnresolvedConflicts(pendingMerge, workingTree);
    // While any conflict is unresolved, its path is surfaced only in the
    // Conflicts section below, not as an ordinary staged/unstaged change -
    // staging a file that still has a pending three-way decision doesn't
    // mean anything until that decision is made.
    const nonConflictChanges = allChanges.filter(c => !unresolvedConflicts.includes(c.path));
    const stagedChanges = nonConflictChanges.filter(c => staged.includes(c.path));
    const unstagedChanges = nonConflictChanges.filter(c => !staged.includes(c.path));

    const existingResizer = sidebar.querySelector('.sidebar-resizer');
    const existingContent = sidebar.querySelector('.git-tab-content');
    const scrollPos = existingContent ? existingContent.scrollTop : 0;
    const existingMsg = document.getElementById('gitCommitMsg');
    let draftMsg = existingMsg ? existingMsg.value : '';
    // One-shot: the amend-shortcut action (clicking "Amend" on a specific
    // commit row) requests this commit's message be loaded into the box the
    // next time Changes renders, then clears the request so it doesn't keep
    // overwriting further edits on every subsequent render.
    if (uiState.drafts.pendingAmendPrefill) {
        const prefillCommit = repo.objects[uiState.drafts.pendingAmendPrefill];
        if (prefillCommit) draftMsg = prefillCommit.message;
        delete uiState.drafts.pendingAmendPrefill;
    }
    if (pendingMerge && !draftMsg.trim() && !pendingMerge.messagePrefilled) {
        draftMsg = pendingMerge.cherryPickMessage || `Merge branch '${pendingMerge.sourceBranch}' into '${pendingMerge.targetBranch}'`;
        pendingMerge.messagePrefilled = true;
        gitSavePendingMerge(dbName, pendingMerge);
    }
    // NOTE: inputs are snapshotted at the point of interaction (the delegated click
    // handler snapshots before dispatching an action, and a live 'input' listener
    // keeps text fields in sync as the user types) - NOT here. This render can run
    // after an action has already written a *new* value into ui.drafts (e.g.
    // "Use as remote" setting the repo field) while the OLD value is still what's
    // on screen; snapshotting here would read that stale DOM value and overwrite
    // the value the action just set, one render before it ever reaches the screen.
    if (uiState.activeTab === 'remote') gitAutoLoadRemoteData(uiState);

    const bodyHtml = uiState.activeTab === 'changes' ? renderChangesTab(stagedChanges, unstagedChanges, draftMsg, pendingMerge, unresolvedConflicts, uiState, !!repo.refs[config.currentBranch], ignoredNewPaths, hasGitignore)
        : uiState.activeTab === 'history' ? renderHistoryTab(repo, config, uiState, dbName)
        : uiState.activeTab === 'config' ? renderConfigTab(dbName, uiState)
        : renderRemoteTab(dbName, uiState);

    sidebar.innerHTML = renderGitHeader() + renderGitTabs(uiState.activeTab) + `<div class="git-tab-content">${bodyHtml}</div>`;

    if (existingResizer) sidebar.appendChild(existingResizer);
    gitEnsureResizer(sidebar);
    window.gitUpdateStatusBranch();
    const newContent = sidebar.querySelector('.git-tab-content');
    if (newContent) newContent.scrollTop = scrollPos;

    const msgEl = document.getElementById('gitCommitMsg');
    if (msgEl) msgEl.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); gitDoCommit(); } });

    injectGitStyles();
};

// --- Event delegation (one listener, guarded against double-binding) -------
if (!window._gitDelegationBound) {
    window._gitDelegationBound = true;
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-git-action]');
        if (el && el.tagName === 'A') e.preventDefault();
        if (!el) return;
        const sidebar = document.getElementById('sourceControlSidebar');
        if (!sidebar || !sidebar.contains(el)) return;
        e.stopPropagation();
        const action = el.dataset.gitAction;
        const path = el.dataset.path;
        switch (action) {
            case 'refresh': window.renderGitPanel(); break;
            case 'close':
                document.getElementById('sourceControlSidebar')?.classList.remove('open');
                document.getElementById('menuSource')?.classList.remove('active');
                document.getElementById('mainMenuDropdown')?.classList.remove('show');
                if (window.saveCurrentUIState) window.saveCurrentUIState();
                break;
            case 'switch-tab': gitSwitchTab(el.dataset.tab); break;
            case 'stage': gitStagePath(path); break;
            case 'unstage': gitUnstagePath(path); break;
            case 'stage-all': gitStageAllChanges(); break;
            case 'create-gitignore': gitCreateDefaultGitignore(); break;
            case 'unstage-all': gitUnstageAllChanges(); break;
            case 'discard': gitDiscardFile(path); break;
            case 'discard-all': gitDiscardAllChanges(); break;
            case 'diff': gitOpenChangeDiff(path); break;
            case 'conflict-diff': gitOpenConflictDiff(path); break;
            case 'resolve-conflict': gitResolveConflict(path, el.dataset.choice); break;
            case 'abort-merge': if (gitGetPendingRebase(db.name)) gitAbortRebase(); else gitAbortMerge(); break;
            case 'commit-file-diff': gitOpenCommitFileDiff(el.dataset.commitId, path); break;
            case 'prefix': gitInsertPrefix(el.dataset.prefix); break;
            case 'commit': gitDoCommit(); break;
            case 'stash': gitStashChanges(); break;
            case 'stash-pop': gitPopStash(el.dataset.stashId); break;
            case 'stash-drop': gitDropStash(el.dataset.stashId); break;
            case 'new-branch': gitNewBranch(); break;
            case 'rename-branch': gitRenameBranch(); break;
            case 'delete-branch': gitDeleteBranch(path); break;
            case 'new-tag': gitNewTag(el.dataset.commitId || null); break;
            case 'reflog-recover': gitReflogRecover(el.dataset.sha); break;
            case 'new-annotated-tag': gitNewAnnotatedTag(el.dataset.commitId || null); break;
            case 'delete-tag': gitDeleteTag(el.dataset.tagName); break;
            case 'toggle-commit': gitToggleCommitExpand(el.dataset.commitId); break;
            case 'restore-commit': gitRestoreToCommit(el.dataset.commitId); break;
            case 'amend-shortcut': {
                // Jump to the Changes tab with amend mode pre-armed and the
                // tip's message pre-filled, rather than amending instantly
                // with no chance to edit the message - the checkbox flow in
                // renderChangesTab is the actual amend UI; this just gets
                // there with the common case (amend the current tip) already
                // set up.
                const ui = gitUi();
                ui.activeTab = 'changes';
                ui.drafts.gitAmendMode = true;
                ui.drafts.pendingAmendPrefill = el.dataset.commitId;
                window.renderGitPanel();
                break;
            }
            case 'revert-commit': gitRevertCommit(el.dataset.commitId); break;
            case 'reset-commit': gitResetToCommit(el.dataset.commitId, el.dataset.mode); break;
            case 'do-merge': { const sel = document.getElementById('gitMergeSelect'); if (sel && sel.value) gitMergeBranch(sel.value); break; }
            case 'do-rebase': { const sel = document.getElementById('gitMergeSelect'); if (sel && sel.value) gitRebaseBranch(sel.value); break; }
            case 'cherry-pick-commit': gitCherryPickCommit(el.dataset.commitId); break;
            case 'push': gitPushToGitHub(); break;
            case 'pull': gitPullFromGitHub(); break;
            case 'fetch': gitFetchOnly(); break;
            case 'connect-github': gitConnectGitHub(); break;
            case 'verify-token': gitVerifyGitHub(); break;
            case 'disconnect-github': gitDisconnectGitHub(); break;
            case 'unlock-keys': gitRequestVaultUnlock(); break;
            case 'save-identity': gitSaveCustomIdentity(); break;
            case 'toggle-section': {
                const ui = gitUi(); const sec = el.dataset.section;
                gitSnapshotInputs(sidebar, ui);
                ui.sections[sec] = !gitSectionOpen(ui, sec);
                window.renderGitPanel();
                break;
            }
            case 'repos-scope': {
                const ui = gitUi(); gitSnapshotInputs(sidebar, ui);
                const state = gitGHState();
                if (state.repos.scope !== el.dataset.scope) { state.repos.scope = el.dataset.scope; gitLoadRepos(true); }
                break;
            }
            case 'repos-reload': gitSnapshotInputs(sidebar, gitUi()); gitLoadRepos(true); break;
            case 'repos-more': gitSnapshotInputs(sidebar, gitUi()); gitLoadRepos(false); break;
            case 'use-repo': gitSnapshotInputs(sidebar, gitUi()); gitUseRepo(el.dataset.repo, el.dataset.branch); break;
            case 'create-repo': gitCreateRepo(); break;
            case 'fork-repo': gitForkRepo(); break;
            case 'create-issue': gitCreateIssue(); break;
            case 'create-pr': gitCreatePullRequest(); break;
            case 'copy-log': gitCopyLog(); break;
            case 'export-log': gitExportLog(); break;
            case 'clear-log': gitClearLog(); break;
        }
    });
    document.addEventListener('change', (e) => {
        const el = e.target;
        if (el.type === 'checkbox' && el.id && el.matches('[data-git-keep]')) {
            const sidebar = document.getElementById('sourceControlSidebar');
            if (sidebar && sidebar.contains(el)) gitUi().drafts[el.id] = el.checked;
        }
        const changeEl = el.closest('[data-git-change-action]');
        if (!changeEl) return;
        if (changeEl.dataset.gitChangeAction === 'switch-branch') gitSwitchBranch(changeEl.value);
        if (changeEl.dataset.gitChangeAction === 'identity-source') gitSetIdentitySource(changeEl.value);
        if (changeEl.dataset.gitChangeAction === 'toggle-amend') {
            if (changeEl.checked) {
                const dbName = db.name;
                const config = getGitConfig(dbName); const repo = getGitRepo(dbName);
                const tipSha = repo.refs[config.currentBranch];
                const ta = document.getElementById('gitCommitMsg');
                if (tipSha && ta && !ta.value.trim()) ta.value = repo.objects[tipSha].message;
            }
            window.renderGitPanel();
        }
    });
    // Keeps ui.drafts in sync with every keystroke in any Config/Remote field. This
    // is what makes typing survive a re-render triggered by something else entirely
    // (a repo-list fetch finishing, another window's async action) while the user is
    // mid-sentence in an unrelated field - the delegated click handler only snapshots
    // at the moment of a click, which isn't enough on its own.
    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!el.id || !el.matches('[data-git-keep]')) return;
        const sidebar = document.getElementById('sourceControlSidebar');
        if (!sidebar || !sidebar.contains(el)) return;
        gitUi().drafts[el.id] = el.type === 'checkbox' ? el.checked : el.value;
        // The Repository field also drives the branch datalist, so typing a new
        // owner/repo should fetch its branches without waiting for a click elsewhere.
        if (el.id === 'gitRepoInput') { const ref = gitParseRepoRef(el.value); if (ref) gitLoadBranches(ref.full); }
    });
}

// --- Wire up the activity bar entry + initial render ------------------------
document.addEventListener('DOMContentLoaded', () => {
    const menuSource = document.getElementById('menuSource');
    const sourceControlSidebar = document.getElementById('sourceControlSidebar');
    if (menuSource && sourceControlSidebar) {
        menuSource.addEventListener('click', () => {
            document.getElementById('mainMenuDropdown')?.classList.remove('show');
            const isOpen = sourceControlSidebar.classList.contains('open');
            if (window.closeAllSidebars) window.closeAllSidebars();
            if (!isOpen) {
                sourceControlSidebar.classList.add('open');
                menuSource.classList.add('active');
                window.renderGitPanel();
            }
            if (window.saveCurrentUIState) window.saveCurrentUIState();
        });
    }
    if (window.renderGitPanel) window.renderGitPanel();

    // --- Status bar branch item -------------------------------------------
    const statusBranch = document.getElementById('statusBranch');
    if (statusBranch) {
        statusBranch.addEventListener('click', (e) => {
            // The picker lives inside this element, so clicks on its rows also
            // bubble here - those are handled (and stopped) by the picker itself.
            if (e.target.closest('#gitBranchPicker')) return;
            e.stopPropagation();
            gitToggleBranchPicker();
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#statusBranch')) gitCloseBranchPicker();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') gitCloseBranchPicker(); });
    }
    window.gitUpdateStatusBranch();

    // Extends the shared refresh hook (same capture-and-chain pattern used
    // elsewhere in this app, e.g. environments.js/now-island.js) so the panel
    // updates itself whenever the rest of the app reloads the file list -
    // after a workspace/window switch, a terminal file op, etc. - without
    // needing to touch loadFilesFromDB's own definition in app.js.
    if (typeof window.loadFilesFromDB === 'function') {
        const prevLoadFilesFromDB = window.loadFilesFromDB;
        window.loadFilesFromDB = async function(...args) {
            const result = prevLoadFilesFromDB.apply(this, args);
            // Hydrate the new/current database's object cache before anything
            // reads repo.objects for it - gitUpdateStatusBranch is a plain
            // synchronous function (it has to be; it's called from many
            // places that don't await), so without this it could run once
            // against an empty cache right after a switch, showing a
            // momentarily-wrong ahead-count until a later render caught up.
            if (typeof db !== 'undefined' && db) await gitHydrateObjectCache(db);
            // The status bar label reflects the active window's repo, so it must
            // follow window/workspace switches even while the panel is closed;
            // the full panel re-render is only needed when it's actually open.
            window.gitUpdateStatusBranch();
            if (document.getElementById('sourceControlSidebar')?.classList.contains('open')) window.renderGitPanel();
            return result;
        };
    }
});