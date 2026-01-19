// Message type definitions

export interface TextSegment {
  type: 'text';
  data: {
    text: string;
  };
}

export interface AtSegment {
  type: 'at';
  data: {
    qq: number | string;
  };
}

export interface FaceSegment {
  type: 'face';
  data: {
    id: number | string;
  };
}

export interface ImageSegment {
  type: 'image';
  data: {
    uri?: string; // File URI, supports file://, http(s)://, base64:// formats
    sub_type?: 'normal' | 'sticker'; // Image type, default: normal
    summary?: string; // Image preview text
    // Milky protocol specific fields
    temp_url?: string; // Temporary download URL provided by Milky protocol
    resource_id?: string; // Resource ID for Milky protocol (requires API call to get actual URL)
  };
}

export interface ReplySegment {
  type: 'reply';
  data: {
    id: number | string;
  };
}

export interface RecordSegment {
  type: 'record';
  data: {
    uri?: string; // File URI, supports file://, http(s)://, base64:// formats
    url?: string;
    data?: string; // Base64 encoded audio data
  };
}

export interface FileSegment {
  type: 'file';
  data: {
    uri?: string; // File URI, supports file://, http(s)://, base64:// formats
    file_id?: string; // File ID from Milky protocol (obtained via upload_group_file or upload_private_file)
    file_name?: string; // File name for display
  };
}

// Input types for MessageBuilder methods
export interface FileInput {
  file?: string; // File path or URI (file://, http(s)://, base64://)
  url?: string; // HTTP/HTTPS URL
  file_id?: string; // File ID from Milky protocol upload API
  file_name?: string; // File name for display
}

export interface ImageInput {
  file?: string; // File path or URI
  url?: string; // HTTP/HTTPS URL
  data?: string; // Base64 encoded image data
}

export interface RecordInput {
  file?: string; // File path or URI
  url?: string; // HTTP/HTTPS URL
  data?: string; // Base64 encoded audio data
}

export type MessageSegment = TextSegment | AtSegment | FaceSegment | ImageSegment | ReplySegment | RecordSegment | FileSegment;

export type Message = string | MessageSegment[];
