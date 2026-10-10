import {defaultState, validateState} from './core.js';
export const STORAGE_KEY='gnot-soxl-v1';
export const BACKUP_KEY='gnot-soxl-backups-v1';
export class DataConflict extends Error {}
export function loadStorage(storage=globalThis.localStorage) {
  try {
    const raw=storage.getItem(STORAGE_KEY);
    return {state:raw?validateState(JSON.parse(raw)):defaultState(),error:null,raw};
  } catch(error){return {state:null,error:'本机数据读取失败：'+error.message+'。原始数据已保留，请恢复备份或下载原始数据。',raw: null};}
}
export function localBackups(storage=globalThis.localStorage) {
  try{return JSON.parse(storage.getItem(BACKUP_KEY)||'[]').filter(x=>x&&typeof x.raw==='string').slice(0,5);}catch{return [];}
}
export async function saveStorage(next, expectedRevision, {backup=true, storage=globalThis.localStorage}={}) {
  const write=()=>{
    const raw=storage.getItem(STORAGE_KEY);
    const old=raw?validateState(JSON.parse(raw)):null;
    if(old && old.revision!==expectedRevision)throw new DataConflict('另一个标签页已保存新版本。请重新载入后再操作，避免覆盖记录。');
    const value=validateState(next);value.revision=(old?.revision??expectedRevision)+1;value.meta.updatedAt=new Date().toISOString();
    if(raw&&backup){const backups=localBackups(storage);backups.unshift({at:new Date().toISOString(),revision:old.revision,raw});storage.setItem(BACKUP_KEY,JSON.stringify(backups.slice(0,5)));}
    // localStorage setItem is atomic; a quota error leaves the prior value intact.
    storage.setItem(STORAGE_KEY,JSON.stringify(value));return value;
  };
  const locks=globalThis.window?.navigator?.locks;
  return locks?.request ? locks.request('gnot-soxl-save',async()=>write()) : write();
}
export async function recoverStorage(next, expectedRaw, {storage=globalThis.localStorage}={}) {
  const write=()=>{
    const raw=storage.getItem(STORAGE_KEY);
    if(raw!==expectedRaw)throw new DataConflict('本机数据已变化，请刷新后重新恢复。');
    const value=validateState(next);value.revision=next.revision+1;value.meta.updatedAt=new Date().toISOString();
    if(raw){const b=localBackups(storage);b.unshift({at:new Date().toISOString(),revision:'原始数据',raw});storage.setItem(BACKUP_KEY,JSON.stringify(b.slice(0,5)));}
    storage.setItem(STORAGE_KEY,JSON.stringify(value));return value;
  };
  const locks=globalThis.window?.navigator?.locks;
  return locks?.request?locks.request('gnot-soxl-save',async()=>write()):write();
}
