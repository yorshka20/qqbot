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
    file: string;
    url?: string;
  };
}

export interface ReplySegment {
  type: 'reply';
  data: {
    id: number | string;
  };
}

export type MessageSegment =
  | TextSegment
  | AtSegment
  | FaceSegment
  | ImageSegment
  | ReplySegment;

export type Message = string | MessageSegment[];
