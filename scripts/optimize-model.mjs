// Use the ONNX protobuf bindings shipped with the pinned runtime.
import schema from '../node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js';

const { ModelProto, TensorProto, AttributeProto } = schema.onnx;

export function optimizeModel(bytes) {
  const model = ModelProto.decode(bytes);
  const { graph } = model;
  const [slice] = graph.node;
  if (slice.opType !== 'Slice' || slice.input[0] !== 'pixels' || slice.output[0] !== '/Slice_output_0') {
    throw new Error('Unexpected preprocessing in the supplied FP32 export.');
  }

  // The uint8 Slice falls back to CPU in WebGPU. Gather selects the same
  // RGB channels on the last axis and is supported on GPU with uint8 input.
  graph.node[0] = {
    name: '/RgbGather',
    opType: 'Gather',
    input: ['pixels', 'rgb_indices'],
    output: slice.output,
    attribute: [{ name: 'axis', type: AttributeProto.AttributeType.INT, i: 3 }],
  };

  const unusedSliceInputs = new Set(slice.input.slice(1));
  for (const node of graph.node) {
    for (const input of node.input) unusedSliceInputs.delete(input);
  }
  graph.initializer = graph.initializer.filter(tensor => !unusedSliceInputs.has(tensor.name));
  graph.initializer.push({
    name: 'rgb_indices', dataType: TensorProto.DataType.INT64, dims: [3], int64Data: [0, 1, 2],
  });
  return ModelProto.encode(model).finish();
}
