// Older-schema fixtures start from the current store. Remove this milestone
// before reconstructing their old tables and setting the historical version.
export function dropChatSchema(db) {
  db.exec(`ALTER TABLE projects DROP COLUMN archived_at;
    ALTER TABLE projects DROP COLUMN archive_generation;
    DROP TABLE library_drafts;
    DROP TABLE retained_versions;
    DROP TABLE retained_objects;
    DROP TABLE library_folders;
    DROP TABLE lane_runs;
    DROP TABLE provider_catalogs;
    DROP TABLE chat_outputs;
    DROP TABLE image_versions;
    DROP TRIGGER protection_created;
    DROP TRIGGER protection_changed;
    DROP TABLE card_tool_calls;
    DROP TABLE card_proposals;
    ALTER TABLE cards DROP COLUMN placement_version;
    DROP TRIGGER chat_card_fields_created;
    DROP TRIGGER chat_card_fields_changed;
    DROP TABLE chat_requests;
    DROP TABLE chat_items;
    DROP TABLE chat_attempts;
    DROP TABLE chat_submissions;
    DROP TABLE chat_conversations;
    DROP TABLE card_chats;
    DROP TABLE card_field_versions;`);
}
