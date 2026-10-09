import BackgroundEntryBuilder, {registerBackgroundListeners} from "~/background/background";

// synchronously, at the top level, before anything async (see registerBackgroundListeners)
registerBackgroundListeners()
BackgroundEntryBuilder.create().start()
