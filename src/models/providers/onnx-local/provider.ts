import { onnxLocalProviderId } from '../../provider-ids.js';

export { onnxLocalProviderId };

/**
 * The onnx-local provider is not registered as a chat provider because it
 * does not serve generative models. The bundled all-MiniLM-L6-v2 model is used
 * directly by the EmbeddingClient fallback path.
 */
