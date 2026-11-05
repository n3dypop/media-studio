// The PK collation and order affect request identity, but table_xinfo omits
// both. Check the actual unique index rather than inferring it from columns.
export function hasBinaryPrimaryKey(db,table,names){
  const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
  const indexes=db.prepare(`PRAGMA index_list(${quote(table)})`).all().filter(index=>index.origin==='pk');
  if(indexes.length!==1||indexes[0].unique!==1||indexes[0].partial!==0)return false;
  const keys=db.prepare(`PRAGMA index_xinfo(${quote(indexes[0].name)})`).all().filter(column=>column.key===1);
  return keys.length===names.length&&keys.every((column,index)=>column.name===names[index]&&column.coll==='BINARY'&&column.desc===0);
}

// Core tables must never be silently recreated in an already initialized
// ledger. Run this inside the caller's IMMEDIATE transaction so the check and
// first installation (or adoption of a complete legacy schema) are atomic.
export function ensureCoreTables(db,{marker,legacyMarkers=[],tables}){
  const markerRow=db.prepare('SELECT value FROM meta WHERE key=?').get(marker);
  if(markerRow&&markerRow.value!=='done')throw Error('Core schema marker is invalid');
  const legacy=legacyMarkers.some(key=>db.prepare('SELECT 1 FROM meta WHERE key=?').get(key));
  const found=tables.map(spec=>db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(spec.name));
  if(found.some(row=>row&&row.type!=='table'))throw Error('Core storage is not a table');
  const missing=found.filter(row=>!row).length;
  if(missing&&(markerRow||legacy||missing!==tables.length))throw Error('Core table is missing after initialization');
  if(missing)for(const spec of tables)db.exec(spec.create);
  for(const spec of tables)assertCoreTable(db,spec);
  if(!markerRow)db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(marker,'done');
}

export function assertCoreTable(db,{name,create,columns,primary,unique=[]}){
  const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
  // table_xinfo omits the collation of non-key columns. Ownership is checked
  // using session_id too, so matching column names and PK indexes is not
  // sufficient: NOCASE there would merge distinct DSH conversations.
  const definition=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name);
  const normalize=sql=>String(sql??'').replace(/\s+/g,'').toLowerCase().replace(/^createtableifnotexists/,'createtable');
  if(definition?.type!=='table'||normalize(definition.sql)!==normalize(create))throw Error(`Core table definition differs: ${name}`);
  const info=db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
  if(info.length!==columns.length||info.some((c,i)=>c.name!==columns[i][0]||String(c.type).toUpperCase()!==columns[i][1]||c.notnull!==columns[i][2]||c.pk!==columns[i][3]||c.hidden!==0))throw Error(`Core table schema differs: ${name}`);
  if(primary&&!(primary.length===1&&primary[0]==='seq')&&!hasBinaryPrimaryKey(db,name,primary))throw Error(`Core primary key differs: ${name}`);
  if(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(name).n!==0||db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all().length!==0)throw Error(`Core table has unexpected dependencies: ${name}`);
  const indexes=db.prepare(`PRAGMA index_list(${quote(name)})`).all();
  for(const expected of unique){
    const matches=indexes.filter(index=>index.unique===1&&index.partial===0).filter(index=>{
      const keys=db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all().filter(column=>column.key===1);
      return keys.length===expected.length&&keys.every((column,i)=>column.name===expected[i]&&column.coll==='BINARY'&&column.desc===0);
    });
    if(matches.length!==1)throw Error(`Core unique key differs: ${name}`);
  }
}
