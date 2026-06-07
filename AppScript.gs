/**
 * NSE Scanner Drive Proxy v2
 * Google Apps Script Web App
 * 
 * Deploy as:
 *   Execute as: Me
 *   Who has access: Anyone
 * 
 * Scopes needed (auto-detected):
 *   https://www.googleapis.com/auth/drive.file
 *   https://www.googleapis.com/auth/script.external_request
 */

// ── Config ───────────────────────────────────────────────────────────────────
const FOLDER_ID   = '1uX1UGhOJg51dazjdwiiPmdn-EpIE0fvv';
const DEALS_SUBFOLDER = 'deals';  // subfolder name inside NSE_Scanner_Data

// NSE URLs
const NSE_BASE        = 'https://archives.nseindia.com/products/content';
const NSE_DEALS_BASE  = 'https://archives.nseindia.com/content/equities';

// NSE fetch headers (mimics browser to avoid blocks)
const NSE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer':         'https://www.nseindia.com/',
};

// ── Router ───────────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    const action = (e.parameter.action || 'list').toLowerCase();

    if (action === 'list')            return handleList();
    if (action === 'file')            return handleFile(e.parameter.id);
    if (action === 'download_bhav')   return handleDownloadBhav(e.parameter.date);
    if (action === 'download_deals')  return handleDownloadDeals(e.parameter.date);
    if (action === 'download_52w')    return handleDownload52W(e.parameter.date);
    if (action === 'sync_all')        return handleSyncAll(e.parameter.date);
    if (action === 'sync_status')     return handleSyncStatus(e.parameter.date);
    if (action === 'download_ss')     return handleDownloadSS(e.parameter.date);
    if (action === 'save_watchlist')  return handleSaveWatchlist(e.parameter.data);
    if (action === 'load_watchlist')  return handleLoadWatchlist();

    return jsonResp({ error: 'Unknown action: ' + action }, 400);
  } catch (err) {
    return jsonResp({ error: err.message, stack: err.stack }, 500);
  }
}

// ── LIST files in folder ──────────────────────────────────────────────────────
function handleList() {
  const folder  = DriveApp.getFolderById(FOLDER_ID);
  const files   = folder.getFiles();
  const result  = [];
  while (files.hasNext()) {
    const f = files.next();
    result.push({ id: f.getId(), name: f.getName(), date: f.getLastUpdated() });
  }
  // Also list deals subfolder if exists
  const subFolders = folder.getFoldersByName(DEALS_SUBFOLDER);
  if (subFolders.hasNext()) {
    const dealFolder = subFolders.next();
    const dealFiles  = dealFolder.getFiles();
    while (dealFiles.hasNext()) {
      const f = dealFiles.next();
      result.push({ id: f.getId(), name: f.getName(), date: f.getLastUpdated() });
    }
  }
  return textResp(JSON.stringify(result));
}

// ── GET file content ──────────────────────────────────────────────────────────
function handleFile(fileId) {
  if (!fileId) return jsonResp({ error: 'Missing id' }, 400);
  const file    = DriveApp.getFileById(fileId);
  const content = file.getBlob().getDataAsString('UTF-8');
  return textResp(content);
}

// ── DOWNLOAD TODAY'S BHAVCOPY ─────────────────────────────────────────────────
function handleDownloadBhav(dateStr) {
  const ds    = dateStr || getTodayStr();
  const fname = 'sec_bhavdata_full_' + ds + '.csv';
  const url   = NSE_BASE + '/' + fname;

  // Check if already exists
  if (fileExistsInFolder(FOLDER_ID, fname)) {
    return jsonResp({ status: 'exists', file: fname, message: 'Already in Drive' });
  }

  const data = fetchNSE(url);
  if (!data) {
    // Try previous trading days (up to 5)
    for (let i = 1; i <= 5; i++) {
      const prev  = getPrevTradingDay(ds, i);
      const pfname = 'sec_bhavdata_full_' + prev + '.csv';
      if (fileExistsInFolder(FOLDER_ID, pfname)) {
        return jsonResp({ status: 'exists', file: pfname, message: 'Previous day already in Drive' });
      }
      const pdata = fetchNSE(NSE_BASE + '/' + pfname);
      if (pdata) {
        const saved = saveToFolder(FOLDER_ID, pfname, pdata, 'text/csv');
        return jsonResp({ status: 'saved', file: pfname, size: pdata.length,
                          message: 'Saved (previous trading day)', fileId: saved });
      }
    }
    return jsonResp({ status: 'error', file: fname, message: 'Could not download from NSE' }, 200);
  }

  const saved = saveToFolder(FOLDER_ID, fname, data, 'text/csv');
  return jsonResp({ status: 'saved', file: fname, size: data.length,
                    message: 'Downloaded and saved to Drive', fileId: saved });
}

// ── DOWNLOAD BULK + BLOCK DEALS ───────────────────────────────────────────────
function handleDownloadDeals(dateStr) {
  const ds            = dateStr || getTodayStr();
  const results       = {};
  const dealsFolderId = getOrCreateSubfolder(FOLDER_ID, DEALS_SUBFOLDER);

  // Helper: try to save deals file, falling back up to 5 previous trading days
  function tryDownloadDeals(prefix, nseFile) {
    // Check today first
    const todayFname = prefix + '_' + ds + '.csv';
    if (fileExistsInFolder(dealsFolderId, todayFname)) {
      return { status: 'exists', file: todayFname, date: ds };
    }
    // Try today's live file (NSE always serves current day)
    const data = fetchNSE(NSE_DEALS_BASE + '/' + nseFile);
    if (data && data.length > 100) {
      const saved = saveToFolder(dealsFolderId, todayFname, data, 'text/csv');
      return { status: 'saved', file: todayFname, date: ds, size: data.length, fileId: saved };
    }
    // Today's file empty/unavailable — check if previous days exist in Drive
    for (let i = 1; i <= 5; i++) {
      const prev   = getPrevTradingDay(ds, i);
      const pfname = prefix + '_' + prev + '.csv';
      if (fileExistsInFolder(dealsFolderId, pfname)) {
        return { status: 'exists', file: pfname, date: prev,
                 message: 'Using previous day (' + prev + ') — today not available' };
      }
    }
    return { status: 'empty', file: todayFname, message: 'No deals data available' };
  }

  results.bulk  = tryDownloadDeals('bulk',  'bulk.csv');
  results.block = tryDownloadDeals('block', 'block.csv');

  return jsonResp({ status: 'done', date: ds, results: results });
}

// ── DOWNLOAD 52W HIGH/LOW ─────────────────────────────────────────────────────
function handleDownload52W(dateStr) {
  const ds    = dateStr || getTodayStr();
  const fname = 'CM_52_wk_High_low.csv';  // always single latest file

  // Try multiple URL patterns
  const urlPatterns = [
    NSE_BASE + '/CM_52_wk_High_low_' + ds + '.csv',
    'https://archives.nseindia.com/content/equities/CM_52_wk_High_low_' + ds + '.csv',
  ];

  let data = null;
  let usedUrl = '';
  for (const url of urlPatterns) {
    data = fetchNSE(url);
    if (data) { usedUrl = url; break; }
  }

  // Try previous days if today not available
  if (!data) {
    for (let i = 1; i <= 7; i++) {
      const prev = getPrevTradingDay(ds, i);
      for (const base of [NSE_BASE, 'https://archives.nseindia.com/content/equities']) {
        data = fetchNSE(base + '/CM_52_wk_High_low_' + prev + '.csv');
        if (data) { usedUrl = base + '/CM_52_wk_High_low_' + prev + '.csv'; break; }
      }
      if (data) break;
    }
  }

  if (!data) {
    // Check if existing file is in Drive already
    if (fileExistsInFolder(FOLDER_ID, fname)) {
      return jsonResp({ status: 'exists', file: fname, message: 'Using existing 52W file in Drive' });
    }
    return jsonResp({ status: 'error', file: fname, message: 'Could not download 52W file from NSE' });
  }

  // Overwrite existing file
  deleteFileFromFolder(FOLDER_ID, fname);
  const saved = saveToFolder(FOLDER_ID, fname, data, 'text/csv');
  return jsonResp({ status: 'saved', file: fname, size: data.length,
                    message: 'Downloaded and saved', url: usedUrl, fileId: saved });
}

// ── SYNC ALL (bhav + deals + 52W in one call) ─────────────────────────────────
function handleSyncAll(dateStr) {
  const ds  = dateStr || getTodayStr();
  const log = [];

  log.push('=== NSE Sync Started: ' + ds + ' (IST) ===');

  // Bhavcopy
  const bhavResult = JSON.parse(handleDownloadBhav(ds).getContent());
  const bhavDate   = bhavResult.file ? bhavResult.file.replace('sec_bhavdata_full_','').replace('.csv','') : ds;
  const bhavIcon   = bhavResult.status === 'error' ? '✗' : bhavResult.status === 'exists' ? 'ℹ' : '✓';
  log.push(bhavIcon + ' Bhavcopy [' + bhavDate + ']: ' + bhavResult.message);

  // Deals
  const dealsResult = JSON.parse(handleDownloadDeals(ds).getContent());
  const bulk        = dealsResult.results?.bulk  || {};
  const block       = dealsResult.results?.block || {};
  const bulkIcon    = bulk.status  === 'saved' ? '✓' : bulk.status  === 'exists' ? 'ℹ' : '⚠';
  const blockIcon   = block.status === 'saved' ? '✓' : block.status === 'exists' ? 'ℹ' : '⚠';
  log.push(bulkIcon  + ' Bulk deals  [' + (bulk.date  || ds) + ']: ' + (bulk.status  || 'error') +
           (bulk.message  ? ' — ' + bulk.message  : ''));
  log.push(blockIcon + ' Block deals [' + (block.date || ds) + ']: ' + (block.status || 'error') +
           (block.message ? ' — ' + block.message : ''));

  // 52W
  const w52Result = JSON.parse(handleDownload52W(ds).getContent());
  const w52Icon   = w52Result.status === 'error' ? '✗' : w52Result.status === 'exists' ? 'ℹ' : '✓';
  log.push(w52Icon + ' 52W H/L: ' + w52Result.message);

  const allOk = bhavResult.status !== 'error';
  // Short selling
  const ssResult = JSON.parse(handleDownloadSS(ds).getContent());
  const ssIcon   = ssResult.status === 'error' ? '✗' : ssResult.status === 'exists' ? 'ℹ' : '✓';
  log.push(ssIcon + ' Short Selling: ' + ssResult.message);

  log.push('=== ' + (allOk ? 'Sync Complete ✓' : 'Sync Partial ⚠') + ' ===');

  // Build a human-readable summary of what date's data is available
  const summary = {
    bhavDate:    bhavDate,
    bulkDate:    bulk.date  || null,
    blockDate:   block.date || null,
    w52Updated:  w52Result.status !== 'error',
  };

  return jsonResp({
    status:  allOk ? 'complete' : 'partial',
    date:    ds,
    summary: summary,
    bhav:    bhavResult,
    deals:   dealsResult,
    w52:     w52Result,
    log:     log,
  });
}

// ── SYNC STATUS — what files exist for a date + fallback dates ───────────────
function handleSyncStatus(dateStr) {
  const ds            = dateStr || getTodayStr();
  const dealsFolderId = getOrCreateSubfolder(FOLDER_ID, DEALS_SUBFOLDER);

  // Check today first, then fall back to find latest available
  function latestAvailable(folder, prefix, suffix, days) {
    for (let i = 0; i <= days; i++) {
      const d = i === 0 ? ds : getPrevTradingDay(ds, i);
      const fname = prefix + d + suffix;
      if (fileExistsInFolder(folder, fname)) return { exists: true, date: d, file: fname };
    }
    return { exists: false, date: null };
  }

  const bhavInfo  = latestAvailable(FOLDER_ID, 'sec_bhavdata_full_', '.csv', 7);
  const bulkInfo  = latestAvailable(dealsFolderId, 'bulk_', '.csv', 7);
  const blockInfo = latestAvailable(dealsFolderId, 'block_', '.csv', 7);
  const w52Exists = fileExistsInFolder(FOLDER_ID, 'CM_52_wk_High_low.csv');

  const ssInfo    = latestAvailable(dealsFolderId, 'shortsell_', '.csv', 7);

  return jsonResp({
    date:       ds,
    bhav:       bhavInfo.exists,
    bhavDate:   bhavInfo.date,
    bulk:       bulkInfo.exists,
    bulkDate:   bulkInfo.date,
    block:      blockInfo.exists,
    blockDate:  blockInfo.date,
    w52:        w52Exists,
    ss:         ssInfo.exists,
    ssDate:     ssInfo.date,
  });
}

// ── DOWNLOAD SHORT SELLING ────────────────────────────────────────────────────
function handleDownloadSS(dateStr) {
  const ds            = dateStr || getTodayStr();
  const dealsFolderId = getOrCreateSubfolder(FOLDER_ID, DEALS_SUBFOLDER);
  const fname         = 'shortsell_' + ds + '.csv';

  if (fileExistsInFolder(dealsFolderId, fname)) {
    return jsonResp({ status: 'exists', file: fname, message: 'Already in Drive' });
  }

  // NSE short selling URL
  const url  = 'https://archives.nseindia.com/content/equities/shortselling_' + ds + '.csv';
  const data = fetchNSE(url);

  if (data && data.length > 100) {
    const saved = saveToFolder(dealsFolderId, fname, data, 'text/csv');
    return jsonResp({ status: 'saved', file: fname, size: data.length,
                      message: 'Downloaded and saved', fileId: saved });
  }

  // Try previous days
  for (let i = 1; i <= 5; i++) {
    const prev   = getPrevTradingDay(ds, i);
    const pfname = 'shortsell_' + prev + '.csv';
    if (fileExistsInFolder(dealsFolderId, pfname)) {
      return jsonResp({ status: 'exists', file: pfname,
                        message: 'Using previous day (' + prev + ')' });
    }
    const purl  = 'https://archives.nseindia.com/content/equities/shortselling_' + prev + '.csv';
    const pdata = fetchNSE(purl);
    if (pdata && pdata.length > 100) {
      const saved = saveToFolder(dealsFolderId, pfname, pdata, 'text/csv');
      return jsonResp({ status: 'saved', file: pfname,
                        message: 'Saved (prev day: ' + prev + ')', fileId: saved });
    }
  }
  return jsonResp({ status: 'empty', file: fname, message: 'No short selling data available' });
}

// ── WATCHLIST SYNC ────────────────────────────────────────────────────────────
function handleSaveWatchlist(encodedData) {
  try {
    const jsonStr = encodedData ? decodeURIComponent(encodedData) : null;
    if (!jsonStr) return jsonResp({ status: 'error', message: 'No data' });
    const fname = 'watchlist.json';
    deleteFileFromFolder(FOLDER_ID, fname);
    saveToFolder(FOLDER_ID, fname, jsonStr, 'application/json');
    return jsonResp({ status: 'saved', message: 'Watchlist synced to Drive' });
  } catch (e) {
    return jsonResp({ status: 'error', message: e.message });
  }
}

function handleLoadWatchlist() {
  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const files  = folder.getFilesByName('watchlist.json');
    if (!files.hasNext()) return jsonResp({ status: 'empty', watchlist: [] });
    const content = files.next().getBlob().getDataAsString('UTF-8');
    return textResp(content);
  } catch (e) {
    return jsonResp({ status: 'error', message: e.message });
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function fetchNSE(url) {
  try {
    // Warmup request to get NSE session cookie
    UrlFetchApp.fetch('https://www.nseindia.com', {
      headers: NSE_HEADERS, muteHttpExceptions: true, followRedirects: true
    });
    const resp = UrlFetchApp.fetch(url, {
      headers: NSE_HEADERS, muteHttpExceptions: true, followRedirects: true
    });
    if (resp.getResponseCode() === 200) {
      const content = resp.getContentText('UTF-8');
      if (content && content.length > 200) return content;
    }
    return null;
  } catch (e) {
    Logger.log('fetchNSE error for ' + url + ': ' + e.message);
    return null;
  }
}

function saveToFolder(folderId, filename, content, mimeType) {
  const folder = DriveApp.getFolderById(folderId);
  const blob   = Utilities.newBlob(content, mimeType, filename);
  const file   = folder.createFile(blob);
  // Make publicly readable
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

function deleteFileFromFolder(folderId, filename) {
  const folder = DriveApp.getFolderById(folderId);
  const files  = folder.getFilesByName(filename);
  while (files.hasNext()) {
    files.next().setTrashed(true);
  }
}

function fileExistsInFolder(folderId, filename) {
  const folder = DriveApp.getFolderById(folderId);
  const files  = folder.getFilesByName(filename);
  return files.hasNext();
}

function getOrCreateSubfolder(parentId, name) {
  const parent  = DriveApp.getFolderById(parentId);
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) {
    const f = folders.next();
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return f.getId();
  }
  const newFolder = parent.createFolder(name);
  newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return newFolder.getId();
}

function getTodayStr() {
  const now = new Date();
  // IST = UTC+5:30
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const dd  = String(ist.getUTCDate()).padStart(2, '0');
  const mm  = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yy  = ist.getUTCFullYear();
  return dd + mm + yy;
}

function getPrevTradingDay(dateStr, n) {
  // dateStr = DDMMYYYY, returns DDMMYYYY n trading days back (skips weekends)
  const dd = parseInt(dateStr.substring(0, 2));
  const mm = parseInt(dateStr.substring(2, 4)) - 1;
  const yy = parseInt(dateStr.substring(4, 8));
  let d = new Date(yy, mm, dd);
  let skipped = 0;
  while (skipped < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) skipped++;  // skip Sun=0, Sat=6
  }
  const rdd = String(d.getDate()).padStart(2, '0');
  const rmm = String(d.getMonth() + 1).padStart(2, '0');
  return rdd + rmm + d.getFullYear();
}

function jsonResp(obj, code) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function textResp(text) {
  return ContentService
    .createTextOutput(text)
    .setMimeType(ContentService.MimeType.TEXT);
}
