import { unwrap, type IDBPTransaction } from "idb";
import type {
  DictionaryArchiveRecord,
  DictionaryEntryRecord,
  DictionaryRecord,
} from "../dictionaries";
import {
  BY_DICTIONARY_TERM,
  DICTIONARIES,
  DICTIONARY_ARCHIVES,
  DICTIONARY_ENTRIES,
  open,
  type YukiDB,
} from "./db";

export async function loadAllDictionaries(): Promise<DictionaryRecord[]> {
  const db = await open();
  return (await db.getAll(DICTIONARIES)).sort((a, b) => a.order - b.order);
}

export type DictionariesTx = IDBPTransaction<
  YukiDB,
  (
    | typeof DICTIONARIES
    | typeof DICTIONARY_ENTRIES
    | typeof DICTIONARY_ARCHIVES
  )[],
  "readwrite"
>;

/** Delete every parsed entry row of a dictionary inside an open transaction. */
export async function deleteDictionaryEntries(
  tx: DictionariesTx,
  dictionaryId: string,
): Promise<void> {
  const index = tx.objectStore(DICTIONARY_ENTRIES).index(BY_DICTIONARY_TERM);
  let cursor = await index.openCursor(
    IDBKeyRange.bound([dictionaryId, ""], [dictionaryId, "￿"]),
  );
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
}

export async function loadDictionaryEntries(
  dictionaryId: string,
  termKey: string,
): Promise<DictionaryEntryRecord[]> {
  const db = await open();
  return db.getAllFromIndex(
    DICTIONARY_ENTRIES,
    BY_DICTIONARY_TERM,
    IDBKeyRange.only([dictionaryId, termKey]),
  );
}

export async function replaceDictionary(
  record: DictionaryRecord,
  archive: Uint8Array,
  entries: DictionaryEntryRecord[],
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const db = await open();
  const tx = db.transaction(
    [DICTIONARIES, DICTIONARY_ENTRIES, DICTIONARY_ARCHIVES],
    "readwrite",
  );
  const entriesStore = tx.objectStore(DICTIONARY_ENTRIES);
  await deleteDictionaryEntries(tx, record.id);
  await tx.objectStore(DICTIONARIES).put(record);
  await tx.objectStore(DICTIONARY_ARCHIVES).put({ id: record.id, bytes: archive });
  onProgress?.(0, entries.length);
  const rawEntriesStore = unwrap(entriesStore);
  const reportEvery = Math.max(1, Math.ceil(entries.length / 50));
  for (const [index, entry] of entries.entries()) {
    rawEntriesStore.put(entry);
    if (
      (index + 1) % reportEvery === 0 &&
      index + 1 < entries.length
    ) {
      onProgress?.(index + 1, entries.length);
    }
  }
  await tx.done;
  const completed = entries.length || 1;
  onProgress?.(completed, completed);
}

export async function deleteDictionary(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(
    [DICTIONARIES, DICTIONARY_ENTRIES, DICTIONARY_ARCHIVES],
    "readwrite",
  );
  await tx.objectStore(DICTIONARIES).delete(id);
  await tx.objectStore(DICTIONARY_ARCHIVES).delete(id);
  await deleteDictionaryEntries(tx, id);
  await tx.done;
}

export async function setDictionaryEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  const db = await open();
  const record = await db.get(DICTIONARIES, id);
  if (!record) return;
  record.enabled = enabled;
  await db.put(DICTIONARIES, record);
}

export async function setDictionaryOrder(ids: string[]): Promise<void> {
  const db = await open();
  const tx = db.transaction(DICTIONARIES, "readwrite");
  for (const [order, id] of ids.entries()) {
    const record = await tx.store.get(id);
    if (record) await tx.store.put({ ...record, order });
  }
  await tx.done;
}

export async function loadDictionaryArchives(): Promise<DictionaryArchiveRecord[]> {
  const db = await open();
  return db.getAll(DICTIONARY_ARCHIVES);
}
