import content from '../../content.json';
import { ContentData } from '../types/content';

export const getContentData = (): ContentData => {
  return content as ContentData;
};
