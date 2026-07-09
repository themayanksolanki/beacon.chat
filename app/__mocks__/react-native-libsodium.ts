// Jest cannot load the native JSI binding that react-native-libsodium uses on
// device/simulator, so unit tests substitute the pure-JS/WASM libsodium-wrappers
// build, which implements the same function names and signatures.
import sodium from "libsodium-wrappers";

export default sodium;
