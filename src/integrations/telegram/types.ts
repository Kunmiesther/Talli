export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  voice?: {
    file_id: string;
    duration?: number;
    mime_type?: string;
    file_size?: number;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramFile {
  file_id: string;
  file_path?: string;
}

export interface TelegramTransport {
  sendMessage(chatId: number, text: string): Promise<void>;
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
  getFile(fileId: string): Promise<TelegramFile>;
  downloadFile(filePath: string): Promise<Uint8Array>;
}
