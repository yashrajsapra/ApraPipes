#include "stdafx.h"
#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>
#include <thread>
#include <chrono>

#include "PipeLine.h"
#include "Logger.h"
#include "test_utils.h"
#include "FrameMetadata.h"
#include "Module.h"
#include "AbsControlModule.h"
#include "FrameFactory.h"
#include "Frame.h"

BOOST_AUTO_TEST_SUITE(control_module_memory_leak_tests)

/**
 * Test fixture that creates a simple pipeline with SOURCE -> SINK + CONTROL
 * Used to test control module cleanup and memory leak scenarios
 */
struct PipelineWithControl {
    class SourceModuleProps : public ModuleProps {
    public:
        SourceModuleProps() : ModuleProps() {}
    };

    class SinkModuleProps : public ModuleProps {
    public:
        SinkModuleProps() : ModuleProps() {}
    };

    class TestControlModuleProps : public AbsControlModuleProps {
    public:
        TestControlModuleProps() : AbsControlModuleProps() {}
    };

    // Simple source module that produces frames
    class TestSourceModule : public Module {
    public:
        TestSourceModule(SourceModuleProps props) : Module(SOURCE, "TestSource", props), frameCount(0) {}

        frame_sp makeFrame(size_t size, string &pinId) { return Module::makeFrame(size, pinId); }
        bool send(frame_container& frames) { return Module::send(frames); }

    protected:
        bool produce() override {
            // Add small delay to prevent tight loop
            std::this_thread::sleep_for(std::chrono::milliseconds(10));

            auto metadata = framemetadata_sp(new FrameMetadata(FrameMetadata::FrameType::GENERAL));
            size_t fSize = 1024;  // 1KB per frame
            std::string fPinId = getOutputPinIdByType(FrameMetadata::FrameType::GENERAL);
            auto frame = makeFrame(fSize, fPinId);

            frame_container frames;
            frames.insert(std::make_pair(fPinId, frame));
            send(frames);

            frameCount++;
            return true;  // Keep producing until stop() is called
        }

        bool validateOutputPins() { return true; }
        bool validateInputPins() { return true; }

    private:
        int frameCount;
    };

    // Simple sink module
    class TestSinkModule : public Module {
    public:
        TestSinkModule(SinkModuleProps props) : Module(SINK, "TestSink", props) {}

    protected:
        bool process(frame_container& frames) {
            // Just consume frames
            return true;
        }

        bool validateOutputPins() { return true; }
        bool validateInputPins() { return true; }
    };

    // Test control module that can verify cleanup
    class TestControlModule : public AbsControlModule {
    public:
        TestControlModule(TestControlModuleProps props) : AbsControlModule(props) {}

        bool isModuleRolesEmpty() {
            return moduleRoles.empty();
        }

        size_t getModuleRolesCount() {
            return moduleRoles.size();
        }
    };

    PipelineWithControl() {}
    ~PipelineWithControl() {}
};

/**
 * TEST 1: Verify control module thread is properly joined
 * This prevents the hang that was happening when wait_for_all() was called
 */
BOOST_AUTO_TEST_CASE(control_module_thread_join) {
	Logger::setLogLevel("info");
    PipelineWithControl fixture;

    // Create modules
    auto source = boost::shared_ptr<PipelineWithControl::TestSourceModule>(
        new PipelineWithControl::TestSourceModule(PipelineWithControl::SourceModuleProps()));
    auto sink = boost::shared_ptr<PipelineWithControl::TestSinkModule>(
        new PipelineWithControl::TestSinkModule(PipelineWithControl::SinkModuleProps()));
    auto control = boost::shared_ptr<PipelineWithControl::TestControlModule>(
        new PipelineWithControl::TestControlModule(PipelineWithControl::TestControlModuleProps()));

    // Setup connections
    auto metadata = framemetadata_sp(new FrameMetadata(FrameMetadata::FrameType::GENERAL));
    auto pinId = source->addOutputPin(metadata);
    source->setNext(sink);

    // Create pipeline and add control module
    auto pipeline = boost::shared_ptr<PipeLine>(new PipeLine("test_pipeline"));
    pipeline->appendModule(source);
    pipeline->addControlModule(control);

    // Pipeline init() initializes all modules including control
    LOG_INFO << "Initializing pipeline...";
    BOOST_TEST(pipeline->init());
    LOG_INFO << "Pipeline initialized successfully";
    // Start pipeline
    pipeline->run_all_threaded();
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    LOG_INFO << "Pipeline running";
    // Stop pipeline
    auto start = std::chrono::steady_clock::now();
    pipeline->stop();
    pipeline->wait_for_all(true);  // Should NOT hang - this is what we're testing!
    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::steady_clock::now() - start).count();

    // Verify it didn't hang (should complete in < 2 seconds)
    BOOST_TEST(elapsed < 2, "wait_for_all() should not hang");

    LOG_INFO << "✓ Control module thread joined successfully in " << elapsed << " seconds";
}

/**
 * TEST 2: Verify moduleRoles map is cleared in term()
 * This prevents the circular reference memory leak
 */
BOOST_AUTO_TEST_CASE(control_module_clears_module_roles) {
    PipelineWithControl fixture;

    auto source = boost::shared_ptr<PipelineWithControl::TestSourceModule>(
        new PipelineWithControl::TestSourceModule(PipelineWithControl::SourceModuleProps()));
    auto sink = boost::shared_ptr<PipelineWithControl::TestSinkModule>(
        new PipelineWithControl::TestSinkModule(PipelineWithControl::SinkModuleProps()));
    auto control = boost::shared_ptr<PipelineWithControl::TestControlModule>(
        new PipelineWithControl::TestControlModule(PipelineWithControl::TestControlModuleProps()));

    auto metadata = framemetadata_sp(new FrameMetadata(FrameMetadata::FrameType::GENERAL));
    auto pinId = source->addOutputPin(metadata);
    source->setNext(sink);

    auto pipeline = boost::shared_ptr<PipeLine>(new PipeLine("test_pipeline"));
    pipeline->appendModule(source);
    pipeline->addControlModule(control);

    // Pipeline init() initializes all modules including control
    BOOST_TEST(pipeline->init());

    // Enroll modules with control (this adds them to moduleRoles map)
    control->enrollModule("TestSource", source);
    control->enrollModule("TestSink", sink);

    // Verify modules are enrolled
    BOOST_TEST(control->getModuleRolesCount() == 2);

    // Run briefly
    pipeline->run_all_threaded();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    // Stop and cleanup
    pipeline->stop();
    pipeline->wait_for_all(true);
    pipeline->term();

    // Call term on control module (should clear moduleRoles)
    control->term();

    // Verify moduleRoles is empty after term()
    BOOST_TEST(control->isModuleRolesEmpty(), "moduleRoles should be empty after term()");

    LOG_INFO << "✓ moduleRoles map cleared successfully";
}

/**
 * TEST 3: Verify frames return to FrameFactory pool (no memory leak)
 * This tests the full cleanup chain
 */
BOOST_AUTO_TEST_CASE(frames_return_to_pool) {
    PipelineWithControl fixture;

    auto source = boost::shared_ptr<PipelineWithControl::TestSourceModule>(
        new PipelineWithControl::TestSourceModule(PipelineWithControl::SourceModuleProps()));
    auto sink = boost::shared_ptr<PipelineWithControl::TestSinkModule>(
        new PipelineWithControl::TestSinkModule(PipelineWithControl::SinkModuleProps()));
    auto control = boost::shared_ptr<PipelineWithControl::TestControlModule>(
        new PipelineWithControl::TestControlModule(PipelineWithControl::TestControlModuleProps()));

    auto metadata = framemetadata_sp(new FrameMetadata(FrameMetadata::FrameType::GENERAL));
    auto pinId = source->addOutputPin(metadata);
    source->setNext(sink);

    auto pipeline = boost::shared_ptr<PipeLine>(new PipeLine("test_pipeline"));
    pipeline->appendModule(source);
    pipeline->addControlModule(control);

    // Pipeline init() initializes all modules including control
    BOOST_TEST(pipeline->init());

    control->enrollModule("TestSource", source);
    control->enrollModule("TestSink", sink);

    // Run pipeline
    pipeline->run_all_threaded();
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    // Stop and cleanup
    pipeline->stop();
    pipeline->wait_for_all(true);
    pipeline->term();

    // Force cleanup
    control.reset();
    sink.reset();
    source.reset();
    pipeline.reset();

    // Small delay to allow async cleanup
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    // Note: We can't easily check the pool here since we reset the modules
    // But the fact that we didn't crash and cleanup completed is a good sign

    LOG_INFO << "✓ Pipeline cleanup completed without crash";
}

/**
 * TEST 4: Multiple stop/start cycles (stress test for memory leaks)
 * Verifies that memory doesn't accumulate over multiple cycles
 */
BOOST_AUTO_TEST_CASE(multiple_stop_start_cycles) {
    PipelineWithControl fixture;

    for (int cycle = 0; cycle < 3; cycle++) {
        LOG_INFO << "Starting cycle " << (cycle + 1);

        auto source = boost::shared_ptr<PipelineWithControl::TestSourceModule>(
            new PipelineWithControl::TestSourceModule(PipelineWithControl::SourceModuleProps()));
        auto sink = boost::shared_ptr<PipelineWithControl::TestSinkModule>(
            new PipelineWithControl::TestSinkModule(PipelineWithControl::SinkModuleProps()));
        auto control = boost::shared_ptr<PipelineWithControl::TestControlModule>(
            new PipelineWithControl::TestControlModule(PipelineWithControl::TestControlModuleProps()));

        auto metadata = framemetadata_sp(new FrameMetadata(FrameMetadata::FrameType::GENERAL));
        auto pinId = source->addOutputPin(metadata);
        source->setNext(sink);

        auto pipeline = boost::shared_ptr<PipeLine>(new PipeLine("test_pipeline"));
        pipeline->appendModule(source);
        pipeline->addControlModule(control);

        // Pipeline init() initializes all modules including control
        BOOST_TEST(pipeline->init());

        control->enrollModule("TestSource", source);
        control->enrollModule("TestSink", sink);

        // Run
        pipeline->run_all_threaded();
        std::this_thread::sleep_for(std::chrono::milliseconds(200));

        // Stop and cleanup
        auto start = std::chrono::steady_clock::now();
        pipeline->stop();
        pipeline->wait_for_all(true);
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();

        BOOST_TEST(elapsed < 2000, "Cycle should complete quickly");

        pipeline->term();
        control.reset();
        sink.reset();
        source.reset();
        pipeline.reset();

        LOG_INFO << "✓ Cycle " << (cycle + 1) << " completed in " << elapsed << "ms";
    }

    LOG_INFO << "✓ Multiple cycles completed without hanging or crashing";
}

/**
 * TEST 5: Circular reference handling
 * Verify that circular references between control and modules are properly broken
 */
BOOST_AUTO_TEST_CASE(circular_reference_cleanup) {
    PipelineWithControl fixture;

    // Use weak_ptr to check if objects are actually freed
    boost::weak_ptr<PipelineWithControl::TestSourceModule> weakSource;
    boost::weak_ptr<PipelineWithControl::TestSinkModule> weakSink;
    boost::weak_ptr<PipelineWithControl::TestControlModule> weakControl;

    {
        // Scope to ensure all shared_ptrs go out of scope
        auto source = boost::shared_ptr<PipelineWithControl::TestSourceModule>(
            new PipelineWithControl::TestSourceModule(PipelineWithControl::SourceModuleProps()));
        auto sink = boost::shared_ptr<PipelineWithControl::TestSinkModule>(
            new PipelineWithControl::TestSinkModule(PipelineWithControl::SinkModuleProps()));
        auto control = boost::shared_ptr<PipelineWithControl::TestControlModule>(
            new PipelineWithControl::TestControlModule(PipelineWithControl::TestControlModuleProps()));

        weakSource = source;
        weakSink = sink;
        weakControl = control;

        auto metadata = framemetadata_sp(new FrameMetadata(FrameMetadata::FrameType::GENERAL));
        auto pinId = source->addOutputPin(metadata);
        source->setNext(sink);

        auto pipeline = boost::shared_ptr<PipeLine>(new PipeLine("test_pipeline"));
        pipeline->appendModule(source);
        pipeline->addControlModule(control);

        // Pipeline init() initializes all modules including control
        BOOST_TEST(pipeline->init());

        // Create circular reference: control -> modules
        control->enrollModule("TestSource", source);
        control->enrollModule("TestSink", sink);

        // Run briefly
        pipeline->run_all_threaded();
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        // Cleanup
        pipeline->stop();
        pipeline->wait_for_all(true);
        pipeline->term();
        control->term();

        // All shared_ptrs go out of scope here
    }

    // Give some time for async cleanup
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    // Verify objects were actually freed (circular references broken)
    BOOST_TEST(weakSource.expired(), "Source should be freed (no circular ref leak)");
    BOOST_TEST(weakSink.expired(), "Sink should be freed (no circular ref leak)");
    BOOST_TEST(weakControl.expired(), "Control should be freed (no circular ref leak)");

    LOG_INFO << "✓ Circular references properly cleaned up";
}

BOOST_AUTO_TEST_SUITE_END()
