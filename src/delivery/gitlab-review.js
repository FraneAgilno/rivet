import { createReviewRequestExecutor } from './review-request.js';

export function createGitlabReviewExecutor(input) {
  return createReviewRequestExecutor('gitlab', input);
}
