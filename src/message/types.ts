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

export type MessageSegment = TextSegment | AtSegment | FaceSegment | ImageSegment | ReplySegment | RecordSegment;

export type Message = string | MessageSegment[];
