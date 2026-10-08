// Older-schema fixtures start from the current store. Remove this milestone
// before reconstructing their old tables and setting the historical version.
export function dropChatSchema(db) {
  db.exec(`DROP TABLE provider_catalogs;
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
