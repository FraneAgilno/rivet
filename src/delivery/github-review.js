import { createReviewRequestExecutor } from './review-request.js';

export function createGithubReviewExecutor(input) {
  return createReviewRequestExecutor('github', input);
}
